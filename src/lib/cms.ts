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
	temporaryUploads?: string[];
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
const PUBLIC_UPLOADS_DIR = "public/uploads/blog";
const PUBLIC_TEMP_UPLOADS_DIR = "public/uploads/tmp/blog";
const MANAGED_UPLOAD_PREFIX = "/uploads/blog/";
const TEMP_UPLOAD_PREFIX = "/uploads/tmp/blog/";
const SITE_HOSTS = new Set(["arunajr.com", "www.arunajr.com"]);
const DEFAULT_OWNER = "arunajati";
const DEFAULT_REPO = "arunajrcom-astro-blog-starter-template";
const DEFAULT_BRANCH = "main";
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const TEMP_UPLOAD_MAX_AGE_MS = 24 * 60 * 60 * 1000;
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

export async function cleanupTemporaryUploads(env: CmsEnv, authorEmail: string, maxAgeMs = TEMP_UPLOAD_MAX_AGE_MS) {
	const uploads = await listTemporaryUploadFiles(env);
	if (uploads.length === 0) return { deleted: 0 };

	const referenced = collectPostImageRefs(await listPosts(env));
	const cutoff = Date.now() - maxAgeMs;
	const deletions = uploads.filter((upload) => {
		const publicPath = publicPathFromRepoPath(upload.path);
		return uploadUploadedAt(publicPath) < cutoff && !referenced.has(publicPath);
	});

	if (deletions.length === 0) return { deleted: 0 };

	await commitGitHubChanges(
		env,
		deletions.map((upload) => ({ path: upload.path, content: null })),
		{
			message: `cms: cleanup ${deletions.length} temporary upload${deletions.length === 1 ? "" : "s"}`,
			authorEmail,
		},
	);

	return { deleted: deletions.length };
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

	const prepared = await preparePostMedia(env, normalized, input.temporaryUploads || [], new Set());
	await commitGitHubChanges(env, [{ path, content: renderPost(prepared.post) }, ...prepared.changes], {
		message: `cms: publish ${prepared.post.slug}`,
		authorEmail,
	});

	return getPost(env, prepared.post.slug);
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

	const currentPost = await getPost(env, currentSlug);
	if (currentPost.sha !== input.sha) {
		throw new CmsError(409, "Konten berubah. Muat ulang sebelum menyimpan.");
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

	const prepared = await preparePostMedia(
		env,
		normalized,
		input.temporaryUploads || [],
		collectPostImageRefs([currentPost]),
		currentPath,
	);
	const changes: GitHubTreeChange[] = [{ path: nextPath, content: renderPost(prepared.post) }, ...prepared.changes];

	if (nextSlug === currentSlug) {
		await commitGitHubChanges(env, changes, {
			message: `cms: update ${currentSlug}`,
			authorEmail,
		});
	} else {
		changes.push({ path: currentPath, content: null });
		await commitGitHubChanges(env, changes, {
			message: `cms: rename ${currentSlug} to ${nextSlug}`,
			authorEmail,
		});
	}

	return getPost(env, prepared.post.slug);
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
	const publicPath = `/uploads/tmp/blog/${year}/${month}/${filename}`;
	const repoPath = `public${publicPath}`;
	const bytes = new Uint8Array(await file.arrayBuffer());

	await writeGitHubFile(env, repoPath, bytes, {
		message: `cms: upload temporary ${filename}`,
		authorEmail,
	});

	return { path: publicPath, temporary: true };
}

export async function deletePost(env: CmsEnv, slug: string, authorEmail: string) {
	const post = await getPost(env, slug);
	const postImages = collectPostImageRefs([post]);
	const otherImages = collectPostImageRefs(await listPostsExcept(env, post.path));
	const deletableImages = [];
	for (const image of postImages) {
		if (!isManagedUploadPath(image) || otherImages.has(image)) continue;
		if (await githubFileExists(env, repoPathFromPublicPath(image))) deletableImages.push(image);
	}

	await commitGitHubChanges(
		env,
		[
			{ path: post.path, content: null },
			...deletableImages.map((image) => ({ path: repoPathFromPublicPath(image), content: null })),
		],
		{
			message: `cms: delete post ${post.slug}`,
			authorEmail,
		},
	);

	return { deleted: true, slug: post.slug, removedImages: deletableImages.length };
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

async function preparePostMedia(
	env: CmsEnv,
	input: CmsPostInput,
	sessionTemporaryUploads: string[],
	previousPostImages: Set<string>,
	currentPostPath?: string,
) {
	const tempCandidates = new Set([
		...sessionTemporaryUploads.filter(isTemporaryUploadPath),
		...collectPostImageRefs([input]).values(),
	].filter(isTemporaryUploadPath));
	const tempToFinal = new Map<string, string>();
	const changes: GitHubTreeChange[] = [];

	for (const tempPath of tempCandidates) {
		const finalPath = permanentPathFromTemporaryPath(tempPath);
		tempToFinal.set(tempPath, finalPath);
		let tempFile: { bytes: Uint8Array } | null = null;
		try {
			tempFile = await readGitHubFileBytes(env, repoPathFromPublicPath(tempPath));
		} catch (error) {
			if (!(error instanceof CmsError) || error.status !== 404) throw error;
		}

		if (isPostInputUsingImage(input, tempPath)) {
			if (!tempFile) throw new CmsError(404, "Temporary image tidak ditemukan. Upload ulang gambar sebelum menyimpan.");
			changes.push({ path: repoPathFromPublicPath(finalPath), content: tempFile.bytes });
		}

		if (tempFile) changes.push({ path: repoPathFromPublicPath(tempPath), content: null });
	}

	let post = replacePostImagePaths(input, tempToFinal);
	const nextImages = collectPostImageRefs([post]);
	const otherImages = collectPostImageRefs(await listPostsExcept(env, currentPostPath));
	for (const oldImage of previousPostImages) {
		if (!isManagedUploadPath(oldImage) || nextImages.has(oldImage) || otherImages.has(oldImage)) continue;
		if (!(await githubFileExists(env, repoPathFromPublicPath(oldImage)))) continue;
		changes.push({ path: repoPathFromPublicPath(oldImage), content: null });
	}

	return { post, changes: dedupeGitHubChanges(changes) };
}

function replacePostImagePaths(input: CmsPostInput, replacements: Map<string, string>): CmsPostInput {
	let body = input.body;
	let heroImage = input.heroImage;
	let seoImage = input.seoImage;

	for (const [from, to] of replacements) {
		body = replaceAll(body, from, to);
		if (heroImage === from) heroImage = to;
		if (seoImage === from) seoImage = to;
	}

	return { ...input, body, heroImage, seoImage, temporaryUploads: [] };
}

function replaceAll(value: string, from: string, to: string) {
	return value.split(from).join(to);
}

function isPostInputUsingImage(input: Pick<CmsPostInput, "heroImage" | "seoImage" | "body">, imagePath: string) {
	return collectImageRefs(input).has(imagePath);
}

function collectPostImageRefs(posts: Array<Pick<CmsPostInput, "heroImage" | "seoImage" | "body">>) {
	const refs = new Set<string>();
	for (const post of posts) {
		for (const ref of collectImageRefs(post)) refs.add(ref);
	}
	return refs;
}

function collectImageRefs(input: Pick<CmsPostInput, "heroImage" | "seoImage" | "body">) {
	const refs = new Set<string>();
	for (const value of [input.heroImage, input.seoImage]) {
		if (value && isLocalUploadPath(value)) refs.add(value.trim());
	}

	const body = input.body || "";
	for (const match of body.matchAll(/<img\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1/gi)) {
		const src = match[2]?.trim();
		if (src && isLocalUploadPath(src)) refs.add(src);
	}
	for (const match of body.matchAll(/!\[[^\]]*]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
		const src = match[1]?.trim();
		if (src && isLocalUploadPath(src)) refs.add(src);
	}
	return refs;
}

async function listPostsExcept(env: CmsEnv, excludedPath?: string) {
	const posts = await listPosts(env);
	return excludedPath ? posts.filter((post) => post.path !== excludedPath) : posts;
}

function isLocalUploadPath(value: string) {
	return isManagedUploadPath(value) || isTemporaryUploadPath(value);
}

function isManagedUploadPath(value: string) {
	return value.startsWith(MANAGED_UPLOAD_PREFIX);
}

function isTemporaryUploadPath(value: string) {
	return value.startsWith(TEMP_UPLOAD_PREFIX);
}

function permanentPathFromTemporaryPath(value: string) {
	if (!isTemporaryUploadPath(value)) return value;
	return value.replace(TEMP_UPLOAD_PREFIX, MANAGED_UPLOAD_PREFIX);
}

function repoPathFromPublicPath(value: string) {
	if (!isLocalUploadPath(value)) throw new CmsError(400, "Path gambar tidak boleh dihapus otomatis.");
	return `public${value}`;
}

function publicPathFromRepoPath(value: string) {
	return value.startsWith("public/") ? value.slice("public".length) : `/${value}`;
}

function uploadUploadedAt(publicPath: string) {
	const filename = publicPath.split("/").pop() || "";
	const timestamp = Number(filename.split("-")[0]);
	return Number.isFinite(timestamp) ? timestamp : 0;
}

async function listTemporaryUploadFiles(env: CmsEnv) {
	return listGitHubFilesRecursive(env, PUBLIC_TEMP_UPLOADS_DIR).catch((error) => {
		if (error instanceof CmsError && error.status === 404) return [];
		throw error;
	});
}

async function listGitHubFilesRecursive(env: CmsEnv, path: string): Promise<GitHubContentItem[]> {
	const items = await githubRequest<GitHubContentItem[]>(env, path, {
		searchParams: { ref: githubBranch(env) },
	});
	const files: GitHubContentItem[] = [];
	for (const item of items) {
		if (item.type === "file") {
			files.push(item);
			continue;
		}
		if (item.type === "dir") {
			files.push(...(await listGitHubFilesRecursive(env, item.path)));
		}
	}
	return files;
}

function dedupeGitHubChanges(changes: GitHubTreeChange[]) {
	const map = new Map<string, GitHubTreeChange>();
	for (const change of changes) map.set(change.path, change);
	return [...map.values()];
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
	const path = normalizeInternalSourceUrl(value, "From URL");
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

function normalizeInternalSourceUrl(value: string, label: string) {
	const trimmed = value?.trim();
	if (!trimmed) throw new CmsError(400, `${label} wajib diisi.`);

	if (/^https?:\/\//i.test(trimmed)) {
		let url: URL;
		try {
			url = new URL(trimmed);
		} catch {
			throw new CmsError(400, `${label} tidak valid.`);
		}

		if (!SITE_HOSTS.has(url.hostname.toLowerCase())) {
			throw new CmsError(400, `${label} harus memakai domain arunajr.com.`);
		}

		return normalizeInternalPath(`${url.pathname}${url.search}`, label);
	}

	return normalizeInternalPath(trimmed, label);
}

function normalizeInternalPath(value: string, label: string) {
	const trimmed = value?.trim();
	if (!trimmed) throw new CmsError(400, `${label} wajib diisi.`);
	if (!trimmed.startsWith("/") || trimmed.startsWith("//")) {
		throw new CmsError(400, `${label} harus berupa path internal atau URL arunajr.com.`);
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

async function readGitHubFileBytes(env: CmsEnv, path: string) {
	const file = await githubRequest<GitHubFileContent>(env, path, {
		searchParams: { ref: githubBranch(env) },
	});
	if (!file.content || !file.sha) {
		throw new CmsError(404, "File tidak ditemukan.");
	}
	return {
		sha: file.sha,
		bytes: bytesFromBase64(file.content),
	};
}

async function githubFileExists(env: CmsEnv, path: string) {
	try {
		await readGitHubFileBytes(env, path);
		return true;
	} catch (error) {
		if (error instanceof CmsError && error.status === 404) return false;
		throw error;
	}
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

async function commitGitHubChanges(
	env: CmsEnv,
	changes: GitHubTreeChange[],
	options: { message: string; authorEmail: string },
) {
	const cleanChanges = dedupeGitHubChanges(changes);
	if (cleanChanges.length === 0) return;

	const branch = githubBranch(env);
	const ref = await githubApiRequest<GitHubRef>(env, `/git/ref/heads/${branch}`);
	const baseCommit = await githubApiRequest<GitHubCommit>(env, `/git/commits/${ref.object.sha}`);

	const tree: GitHubTreeEntry[] = [];
	for (const change of cleanChanges) {
		if (change.content === null) {
			tree.push({
				path: change.path,
				mode: "100644",
				type: "blob",
				sha: null,
			});
			continue;
		}

		const blob = await githubApiRequest<GitHubBlob>(env, "/git/blobs", {
			method: "POST",
			body: {
				content: typeof change.content === "string" ? change.content : base64FromBytes(change.content),
				encoding: typeof change.content === "string" ? "utf-8" : "base64",
			},
		});
		tree.push({
			path: change.path,
			mode: "100644",
			type: "blob",
			sha: blob.sha,
		});
	}

	const nextTree = await githubApiRequest<GitHubTree>(env, "/git/trees", {
		method: "POST",
		body: {
			base_tree: baseCommit.tree.sha,
			tree,
		},
	});
	const nextCommit = await githubApiRequest<GitHubCommit>(env, "/git/commits", {
		method: "POST",
		body: {
			message: options.message,
			tree: nextTree.sha,
			parents: [ref.object.sha],
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

	await githubApiRequest(env, `/git/refs/heads/${branch}`, {
		method: "PATCH",
		body: {
			sha: nextCommit.sha,
			force: false,
		},
	});
}

async function githubApiRequest<T>(
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

	const url = new URL(`https://api.github.com/repos/${githubOwner(env)}/${githubRepo(env)}${path}`);
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
	const bytes = bytesFromBase64(value);
	return new TextDecoder().decode(bytes);
}

function bytesFromBase64(value: string) {
	const binary = atob(value.replace(/\s/g, ""));
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
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

type GitHubTreeChange = {
	path: string;
	content: string | Uint8Array | null;
};

type GitHubRef = {
	object: {
		sha: string;
	};
};

type GitHubCommit = {
	sha: string;
	tree: {
		sha: string;
	};
};

type GitHubBlob = {
	sha: string;
};

type GitHubTree = {
	sha: string;
};

type GitHubTreeEntry = {
	path: string;
	mode: "100644";
	type: "blob";
	sha: string | null;
};
