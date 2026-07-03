export type CmsEnv = {
	GITHUB_TOKEN?: string;
	CMS_GITHUB_OWNER?: string;
	CMS_GITHUB_REPO?: string;
	CMS_GITHUB_BRANCH?: string;
	CMS_ALLOWED_EMAILS?: string;
};

export type CmsPostInput = {
	slug: string;
	title: string;
	description: string;
	seoTitle?: string;
	seoDescription?: string;
	seoImage?: string;
	pubDate: string;
	updatedDate?: string;
	heroImage?: string;
	status?: CmsPostStatus;
	body: string;
	sha?: string;
};

export type CmsPostStatus = "draft" | "published";

export type CmsPost = CmsPostInput & {
	path: string;
	sha: string;
};

export type CmsRedirectStatusCode = 301 | 302;

export type CmsRedirectInput = {
	from: string;
	to: string;
	statusCode?: CmsRedirectStatusCode;
	enabled?: boolean;
};

export type CmsRedirect = CmsRedirectInput & {
	id: string;
	statusCode: CmsRedirectStatusCode;
	enabled: boolean;
	updatedAt: string;
};

export type CmsRedirectState = {
	redirects: CmsRedirect[];
	sha: string;
};

export class CmsError extends Error {
	status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

const BLOG_DIR = "src/content/blog";
const REDIRECTS_FILE = "src/data/redirects.json";
const DEFAULT_OWNER = "arunajati";
const DEFAULT_REPO = "arunajrcom-astro-blog-starter-template";
const DEFAULT_BRANCH = "main";
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Map([
	["image/jpeg", "jpg"],
	["image/png", "png"],
	["image/webp", "webp"],
]);

export function jsonResponse(data: unknown, init: ResponseInit = {}) {
	return new Response(JSON.stringify(data), {
		...init,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
			...init.headers,
		},
	});
}

export function handleCmsError(error: unknown) {
	if (error instanceof CmsError) {
		return jsonResponse({ error: error.message }, { status: error.status });
	}

	console.error(error);
	return jsonResponse({ error: "Terjadi kesalahan pada CMS." }, { status: 500 });
}

export function requireAdmin(request: Request, env: CmsEnv) {
	const email = request.headers.get("cf-access-authenticated-user-email");
	const allowedEmails = parseCsv(env.CMS_ALLOWED_EMAILS).map((item) => item.toLowerCase());

	if (import.meta.env.DEV && !email) {
		return { email: "local-dev@arunajr.local" };
	}

	if (!email) {
		throw new CmsError(401, "Akses admin membutuhkan Cloudflare Access.");
	}

	if (allowedEmails.length === 0) {
		throw new CmsError(403, "CMS_ALLOWED_EMAILS belum dikonfigurasi.");
	}

	if (!allowedEmails.includes(email.toLowerCase())) {
		throw new CmsError(403, "Email ini tidak memiliki akses CMS.");
	}

	return { email };
}

export async function listPosts(env: CmsEnv): Promise<CmsPost[]> {
	const files = await githubRequest<GitHubContentItem[]>(env, BLOG_DIR);
	const markdownFiles = files
		.filter((file) => file.type === "file" && /\.(md|mdx)$/i.test(file.name))
		.sort((a, b) => a.name.localeCompare(b.name));

	const posts = await Promise.all(
		markdownFiles.map(async (file) => {
			const content = await readGitHubFile(env, file.path);
			return parsePost(file.path, content.content, content.sha);
		}),
	);

	return posts.sort((a, b) => dateValue(b.pubDate) - dateValue(a.pubDate));
}

export async function getPost(env: CmsEnv, slug: string): Promise<CmsPost> {
	const safeSlug = normalizeSlug(slug);
	const path = postPath(safeSlug);
	const content = await readGitHubFile(env, path);
	return parsePost(path, content.content, content.sha);
}

export async function createPost(env: CmsEnv, input: CmsPostInput, authorEmail: string) {
	const normalized = validatePostInput(input);
	const path = postPath(normalized.slug);

	try {
		await readGitHubFile(env, path);
		throw new CmsError(409, "Slug sudah dipakai artikel lain.");
	} catch (error) {
		if (error instanceof CmsError && error.status !== 404) {
			throw error;
		}
	}

	await writeGitHubFile(env, path, renderPost(normalized), {
		message: `cms: publish ${normalized.slug}`,
		authorEmail,
	});

	return getPost(env, normalized.slug);
}

export async function updatePost(env: CmsEnv, slug: string, input: CmsPostInput, authorEmail: string) {
	const currentSlug = normalizeSlug(slug);
	const normalized = validatePostInput(input);
	const nextSlug = normalized.slug;
	const currentPath = postPath(currentSlug);
	const nextPath = postPath(nextSlug);

	if (!input.sha) {
		throw new CmsError(409, "Data artikel perlu dimuat ulang sebelum disimpan.");
	}

	if (nextSlug !== currentSlug) {
		await readGitHubFile(env, nextPath).then(
			() => {
				throw new CmsError(409, "Slug baru sudah dipakai artikel lain.");
			},
			(error) => {
				if (!(error instanceof CmsError) || error.status !== 404) throw error;
			},
		);
	}

	if (nextSlug === currentSlug) {
		await writeGitHubFile(env, nextPath, renderPost(normalized), {
			message: `cms: update ${currentSlug}`,
			sha: input.sha,
			authorEmail,
		});
	} else {
		await writeGitHubFile(env, nextPath, renderPost(normalized), {
			message: `cms: rename ${currentSlug} to ${nextSlug}`,
			authorEmail,
		});
		await deleteGitHubFile(env, currentPath, input.sha, authorEmail);
	}

	return getPost(env, nextSlug);
}

export async function uploadImage(env: CmsEnv, file: File, authorEmail: string, fileSlug?: string) {
	if (!file || file.size === 0) {
		throw new CmsError(400, "File gambar wajib diisi.");
	}

	if (file.size > MAX_IMAGE_BYTES) {
		throw new CmsError(400, "Ukuran gambar maksimal 2 MB.");
	}

	const extension = ALLOWED_IMAGE_TYPES.get(file.type);
	if (!extension) {
		throw new CmsError(400, "Format gambar harus JPG, PNG, atau WebP.");
	}

	const now = new Date();
	const year = String(now.getUTCFullYear());
	const month = String(now.getUTCMonth() + 1).padStart(2, "0");
	const name = fileSlug || file.name.replace(/\.[^.]+$/, "");
	const safeName = normalizeSlug(name || "image");
	const filename = `${Date.now()}-${safeName}.${extension}`;
	const publicPath = `/uploads/blog/${year}/${month}/${filename}`;
	const repoPath = `public${publicPath}`;
	const bytes = new Uint8Array(await file.arrayBuffer());

	await writeGitHubFile(env, repoPath, bytes, {
		message: `cms: upload ${filename}`,
		authorEmail,
	});

	return { path: publicPath };
}

export async function listRedirects(env: CmsEnv): Promise<CmsRedirectState> {
	const content = await readGitHubFile(env, REDIRECTS_FILE);
	return {
		redirects: parseRedirects(content.content),
		sha: content.sha,
	};
}

export async function createRedirect(env: CmsEnv, input: CmsRedirectInput, authorEmail: string) {
	const state = await listRedirects(env);
	const redirect = normalizeRedirectInput(input, {
		id: crypto.randomUUID(),
		updatedAt: new Date().toISOString(),
	});

	ensureRedirectFromIsUnique(state.redirects, redirect.from);
	const redirects = sortRedirects([...state.redirects, redirect]);
	await writeRedirects(env, redirects, state.sha, `cms: create redirect ${redirect.from}`, authorEmail);
	return { redirect, redirects };
}

export async function updateRedirect(env: CmsEnv, id: string, input: CmsRedirectInput, authorEmail: string) {
	const state = await listRedirects(env);
	const index = state.redirects.findIndex((redirect) => redirect.id === id);
	if (index === -1) throw new CmsError(404, "Redirect tidak ditemukan.");

	const redirect = normalizeRedirectInput(input, {
		id,
		updatedAt: new Date().toISOString(),
	});
	ensureRedirectFromIsUnique(state.redirects, redirect.from, id);

	const redirects = [...state.redirects];
	redirects[index] = redirect;
	const sortedRedirects = sortRedirects(redirects);
	await writeRedirects(env, sortedRedirects, state.sha, `cms: update redirect ${redirect.from}`, authorEmail);
	return { redirect, redirects: sortedRedirects };
}

export async function deleteRedirect(env: CmsEnv, id: string, authorEmail: string) {
	const state = await listRedirects(env);
	const redirect = state.redirects.find((item) => item.id === id);
	if (!redirect) throw new CmsError(404, "Redirect tidak ditemukan.");

	const redirects = state.redirects.filter((item) => item.id !== id);
	await writeRedirects(env, redirects, state.sha, `cms: delete redirect ${redirect.from}`, authorEmail);
	return { redirects };
}

function validatePostInput(input: CmsPostInput): CmsPostInput {
	const slug = normalizeSlug(input.slug);
	const title = input.title?.trim();
	const description = input.description?.trim();
	const seoTitle = input.seoTitle?.trim();
	const seoDescription = input.seoDescription?.trim();
	const seoImage = input.seoImage?.trim();
	const pubDate = input.pubDate?.trim();
	const updatedDate = input.updatedDate?.trim();
	const heroImage = input.heroImage?.trim();
	const body = input.body?.trim();
	const status = normalizeStatus(input.status);

	if (!title) throw new CmsError(400, "Judul wajib diisi.");
	if (!description) throw new CmsError(400, "Deskripsi wajib diisi.");
	if (!pubDate || Number.isNaN(new Date(pubDate).valueOf())) {
		throw new CmsError(400, "Tanggal publish tidak valid.");
	}
	if (updatedDate && Number.isNaN(new Date(updatedDate).valueOf())) {
		throw new CmsError(400, "Tanggal update tidak valid.");
	}
	if (!body) throw new CmsError(400, "Isi artikel wajib diisi.");

	return {
		slug,
		title,
		description,
		seoTitle,
		seoDescription,
		seoImage,
		pubDate,
		updatedDate,
		heroImage,
		status,
		body,
		sha: input.sha,
	};
}

function parsePost(path: string, content: string, sha: string): CmsPost {
	const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
	if (!match) {
		throw new CmsError(500, `Format frontmatter tidak valid: ${path}`);
	}

	const data = parseFrontmatter(match[1]);
	return {
		slug: slugFromPath(path),
		title: data.title || "",
		description: data.description || "",
		seoTitle: data.seoTitle,
		seoDescription: data.seoDescription,
		seoImage: data.seoImage,
		pubDate: data.pubDate || "",
		updatedDate: data.updatedDate,
		heroImage: data.heroImage,
		status: normalizeStatus(data.status),
		body: match[2].trim(),
		path,
		sha,
	};
}

function renderPost(input: CmsPostInput) {
	const body = normalizeImageAlts(input.body.trim(), input.seoTitle || input.title);
	const heroImage = resolvePostHeroImage({ heroImage: input.heroImage, body });
	const lines = [
		"---",
		`title: ${quoteYaml(input.title)}`,
		`description: ${quoteYaml(input.description)}`,
		`pubDate: ${quoteYaml(input.pubDate)}`,
	];

	if (input.seoTitle) lines.push(`seoTitle: ${quoteYaml(input.seoTitle)}`);
	if (input.seoDescription) lines.push(`seoDescription: ${quoteYaml(input.seoDescription)}`);
	if (input.seoImage) lines.push(`seoImage: ${quoteYaml(input.seoImage)}`);
	if (input.updatedDate) lines.push(`updatedDate: ${quoteYaml(input.updatedDate)}`);
	if (heroImage) lines.push(`heroImage: ${quoteYaml(heroImage)}`);
	lines.push(`status: ${quoteYaml(normalizeStatus(input.status))}`);

	lines.push("---", "", body, "");
	return lines.join("\n");
}

function parseFrontmatter(raw: string) {
	const data: Record<string, string> = {};
	for (const line of raw.split("\n")) {
		const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (!match) continue;
		data[match[1]] = unquoteYaml(match[2].trim());
	}
	return data;
}

function quoteYaml(value: string) {
	return JSON.stringify(value);
}

function unquoteYaml(value: string) {
	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		return value.slice(1, -1);
	}
	return value;
}

export function normalizeSlug(value: string) {
	const slug = value
		.toLowerCase()
		.trim()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");

	if (!slug) throw new CmsError(400, "Slug wajib diisi.");
	if (slug.length > 120) throw new CmsError(400, "Slug maksimal 120 karakter.");
	return slug;
}

export function resolvePostHeroImage(input: Pick<CmsPostInput, "heroImage" | "body">) {
	const explicitHero = input.heroImage?.trim();
	if (explicitHero) return explicitHero;

	return extractFirstImageSrc(input.body) || "";
}

function postPath(slug: string) {
	return `${BLOG_DIR}/${slug}.md`;
}

function slugFromPath(path: string) {
	return path.split("/").pop()?.replace(/\.(md|mdx)$/i, "") || "";
}

function dateValue(value: string) {
	const date = new Date(value);
	return Number.isNaN(date.valueOf()) ? 0 : date.valueOf();
}

function parseCsv(value?: string) {
	return (value || "")
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

function normalizeStatus(value?: string): CmsPostStatus {
	return value === "draft" ? "draft" : "published";
}

function normalizeImageAlts(body: string, fallbackAlt: string) {
	return body.replace(/<img\b[^>]*>/gi, (tag) => {
		const altMatch = tag.match(/\salt\s*=\s*(["'])(.*?)\1/i);
		if (altMatch && altMatch[2].trim()) {
			return tag;
		}

		const alt = quoteAttribute(fallbackAlt || "Aruna JR");
		if (altMatch) {
			return tag.replace(altMatch[0], ` alt=${alt}`);
		}

		return tag.replace(/>$/, ` alt=${alt}>`);
	});
}

function quoteAttribute(value: string) {
	return `"${String(value || "").replace(/"/g, "&quot;")}"`;
}

function extractFirstImageSrc(body: string) {
	const htmlMatch = body.match(/<img\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1/i);
	if (htmlMatch?.[2]?.trim()) {
		return htmlMatch[2].trim();
	}

	const markdownMatch = body.match(/!\[[^\]]*]\(([^)\s]+)(?:\s+"[^"]*")?\)/);
	if (markdownMatch?.[1]?.trim()) {
		return markdownMatch[1].trim();
	}

	return "";
}

function parseRedirects(content: string) {
	try {
		const data = JSON.parse(content) as { redirects?: CmsRedirect[] };
		if (!Array.isArray(data.redirects)) return [];
		return sortRedirects(
			data.redirects.map((redirect) =>
				normalizeRedirectInput(redirect, {
					id: redirect.id,
					updatedAt: redirect.updatedAt,
				}),
			),
		);
	} catch {
		throw new CmsError(500, "Format redirects.json tidak valid.");
	}
}

function normalizeRedirectInput(
	input: CmsRedirectInput & { id?: string; updatedAt?: string },
	options: { id?: string; updatedAt?: string } = {},
): CmsRedirect {
	const from = normalizeRedirectFrom(input.from);
	const to = normalizeRedirectTo(input.to);
	const statusCode = input.statusCode === 302 ? 302 : 301;
	const id = options.id || input.id || crypto.randomUUID();
	const updatedAt = options.updatedAt || input.updatedAt || new Date().toISOString();

	if (normalizeComparableUrl(from) === normalizeComparableUrl(to)) {
		throw new CmsError(400, "From URL dan To URL tidak boleh sama.");
	}

	return {
		id,
		from,
		to,
		statusCode,
		enabled: input.enabled !== false,
		updatedAt,
	};
}

function normalizeRedirectFrom(value: string) {
	const path = normalizeInternalPath(value, "From URL");
	if (path.includes("?")) {
		throw new CmsError(400, "From URL tidak boleh memakai query string.");
	}
	const blockedPrefixes = ["/admin", "/admin/api", "/_astro", "/uploads"];
	if (blockedPrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
		throw new CmsError(400, "From URL tidak boleh memakai area sistem.");
	}
	return path;
}

function normalizeRedirectTo(value: string) {
	const trimmed = value?.trim();
	if (!trimmed) throw new CmsError(400, "To URL wajib diisi.");

	if (/^https?:\/\//i.test(trimmed)) {
		try {
			return new URL(trimmed).toString();
		} catch {
			throw new CmsError(400, "To URL tidak valid.");
		}
	}

	return normalizeInternalPath(trimmed, "To URL");
}

function normalizeInternalPath(value: string, label: string) {
	const trimmed = value?.trim();
	if (!trimmed) throw new CmsError(400, `${label} wajib diisi.`);
	if (!trimmed.startsWith("/") || trimmed.startsWith("//")) {
		throw new CmsError(400, `${label} harus berupa path internal, contoh /blog/url-lama/.`);
	}
	if (trimmed.includes("#")) {
		throw new CmsError(400, `${label} tidak boleh memakai anchor #.`);
	}

	const [path, query = ""] = trimmed.split("?");
	const cleanPath = path.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
	const normalizedPath = cleanPath === "/" ? "/" : `${cleanPath}/`;
	return query ? `${normalizedPath}?${query}` : normalizedPath;
}

function normalizeComparableUrl(value: string) {
	return value.replace(/\/$/, "");
}

function ensureRedirectFromIsUnique(redirects: CmsRedirect[], from: string, currentId?: string) {
	const duplicate = redirects.find(
		(redirect) => redirect.id !== currentId && normalizeComparableUrl(redirect.from) === normalizeComparableUrl(from),
	);
	if (duplicate) {
		throw new CmsError(409, "From URL sudah dipakai redirect lain.");
	}
}

function sortRedirects(redirects: CmsRedirect[]) {
	return [...redirects].sort((a, b) => a.from.localeCompare(b.from));
}

async function writeRedirects(
	env: CmsEnv,
	redirects: CmsRedirect[],
	sha: string,
	message: string,
	authorEmail: string,
) {
	await writeGitHubFile(env, REDIRECTS_FILE, `${JSON.stringify({ redirects }, null, 2)}\n`, {
		message,
		sha,
		authorEmail,
	});
}

async function readGitHubFile(env: CmsEnv, path: string) {
	const file = await githubRequest<GitHubFileContent>(env, path, {
		searchParams: { ref: githubBranch(env) },
	});
	if (!file.content || !file.sha) {
		throw new CmsError(404, "File tidak ditemukan.");
	}
	return {
		sha: file.sha,
		content: utf8FromBase64(file.content),
	};
}

async function writeGitHubFile(
	env: CmsEnv,
	path: string,
	content: string | Uint8Array,
	options: { message: string; sha?: string; authorEmail: string },
) {
	await githubRequest(env, path, {
		method: "PUT",
		body: {
			message: options.message,
			content: typeof content === "string" ? base64FromUtf8(content) : base64FromBytes(content),
			branch: githubBranch(env),
			sha: options.sha,
			committer: {
				name: "Aruna JR CMS",
				email: options.authorEmail,
			},
			author: {
				name: "Aruna JR CMS",
				email: options.authorEmail,
			},
		},
	});
}

async function githubRequest<T>(
	env: CmsEnv,
	path: string,
	options: {
		method?: string;
		body?: unknown;
		searchParams?: Record<string, string>;
	} = {},
): Promise<T> {
	const token = env.GITHUB_TOKEN;
	if (!token) {
		throw new CmsError(500, "GITHUB_TOKEN belum dikonfigurasi.");
	}

	const encodedPath = path.split("/").map(encodeURIComponent).join("/");
	const url = new URL(
		`https://api.github.com/repos/${githubOwner(env)}/${githubRepo(env)}/contents/${encodedPath}`,
	);
	for (const [key, value] of Object.entries(options.searchParams || {})) {
		url.searchParams.set(key, value);
	}

	const response = await fetch(url, {
		method: options.method || "GET",
		headers: {
			accept: "application/vnd.github+json",
			authorization: `Bearer ${token}`,
			"user-agent": "arunajr-cms",
			"x-github-api-version": "2022-11-28",
			...(options.body ? { "content-type": "application/json" } : {}),
		},
		body: options.body ? JSON.stringify(options.body) : undefined,
	});

	if (!response.ok) {
		if (response.status === 404) throw new CmsError(404, "Data GitHub tidak ditemukan.");
		if (response.status === 409) throw new CmsError(409, "Konten berubah. Muat ulang sebelum menyimpan.");
		const message = await response.text();
		throw new CmsError(response.status, `GitHub API gagal: ${message}`);
	}

	return response.json() as Promise<T>;
}

async function deleteGitHubFile(env: CmsEnv, path: string, sha: string, authorEmail: string) {
	await githubRequest(env, path, {
		method: "DELETE",
		body: {
			message: `cms: delete old article ${path}`,
			sha,
			branch: githubBranch(env),
			committer: {
				name: "Aruna JR CMS",
				email: authorEmail,
			},
			author: {
				name: "Aruna JR CMS",
				email: authorEmail,
			},
		},
	});
}

function githubOwner(env: CmsEnv) {
	return env.CMS_GITHUB_OWNER || DEFAULT_OWNER;
}

function githubRepo(env: CmsEnv) {
	return env.CMS_GITHUB_REPO || DEFAULT_REPO;
}

function githubBranch(env: CmsEnv) {
	return env.CMS_GITHUB_BRANCH || DEFAULT_BRANCH;
}

function base64FromUtf8(value: string) {
	return base64FromBytes(new TextEncoder().encode(value));
}

function base64FromBytes(bytes: Uint8Array) {
	let binary = "";
	const chunkSize = 0x8000;
	for (let i = 0; i < bytes.length; i += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
	}
	return btoa(binary);
}

function utf8FromBase64(value: string) {
	const binary = atob(value.replace(/\s/g, ""));
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) {
		bytes[i] = binary.charCodeAt(i);
	}
	return new TextDecoder().decode(bytes);
}

type GitHubContentItem = {
	name: string;
	path: string;
	sha: string;
	type: string;
};

type GitHubFileContent = {
	content?: string;
	sha?: string;
};
