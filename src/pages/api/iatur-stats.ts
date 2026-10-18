import type { APIRoute } from "astro";

type IAturMetric = "visit" | "download";

type MetricRow = {
	metric: IAturMetric;
	count: number;
};

type IAturStats = {
	visits: number;
	downloads: number;
	total: number;
};

const JSON_HEADERS = {
	"Cache-Control": "no-store, max-age=0",
	"Content-Type": "application/json; charset=utf-8",
	"X-Content-Type-Options": "nosniff",
};

export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
	const database = locals.runtime?.env.IATUR_STATS;

	if (!database) {
		return json({ error: "Statistik belum tersedia." }, 503);
	}

	try {
		return json(await readStats(database));
	} catch (error) {
		console.error(JSON.stringify({ event: "iatur_stats_read_failed", error: errorMessage(error) }));
		return json({ error: "Statistik belum dapat dimuat." }, 503);
	}
};

export const POST: APIRoute = async ({ request, locals }) => {
	const database = locals.runtime?.env.IATUR_STATS;

	if (!database) {
		return json({ error: "Statistik belum tersedia." }, 503);
	}

	if (!isSameOrigin(request)) {
		return json({ error: "Permintaan ditolak." }, 403);
	}

	const contentLength = Number(request.headers.get("content-length") || 0);
	if (contentLength > 256 || !request.headers.get("content-type")?.includes("application/json")) {
		return json({ error: "Format permintaan tidak valid." }, 400);
	}

	let metric: IAturMetric;
	try {
		const payload = (await request.json()) as { event?: unknown };
		if (payload.event !== "visit" && payload.event !== "download") {
			return json({ error: "Jenis interaksi tidak valid." }, 400);
		}
		metric = payload.event;
	} catch {
		return json({ error: "Format permintaan tidak valid." }, 400);
	}

	try {
		await database
			.prepare(`
				INSERT INTO iatur_metrics (metric, count, updated_at)
				VALUES (?, 1, CURRENT_TIMESTAMP)
				ON CONFLICT(metric) DO UPDATE SET
					count = count + 1,
					updated_at = CURRENT_TIMESTAMP
			`)
			.bind(metric)
			.run();

		return json(await readStats(database));
	} catch (error) {
		console.error(JSON.stringify({ event: "iatur_stats_increment_failed", metric, error: errorMessage(error) }));
		return json({ error: "Interaksi belum dapat dicatat." }, 503);
	}
};

async function readStats(database: D1Database): Promise<IAturStats> {
	const result = await database
		.prepare("SELECT metric, count FROM iatur_metrics WHERE metric IN ('visit', 'download')")
		.all<MetricRow>();

	let visits = 0;
	let downloads = 0;

	for (const row of result.results) {
		if (row.metric === "visit") visits = Number(row.count) || 0;
		if (row.metric === "download") downloads = Number(row.count) || 0;
	}

	return { visits, downloads, total: visits + downloads };
}

function isSameOrigin(request: Request) {
	const origin = request.headers.get("origin");
	return !origin || origin === new URL(request.url).origin;
}

function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : "Unknown error";
}
