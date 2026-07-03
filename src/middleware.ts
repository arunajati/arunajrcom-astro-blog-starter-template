import { defineMiddleware } from "astro:middleware";
import redirectsData from "./data/redirects.json";

const redirects = redirectsData.redirects
	.filter((redirect) => redirect.enabled)
	.map((redirect) => ({
		...redirect,
		from: normalizePath(redirect.from),
		statusCode: redirect.statusCode === 302 ? 302 : 301,
	}));

export const onRequest = defineMiddleware((context, next) => {
	const url = new URL(context.request.url);
	const pathname = normalizePath(url.pathname);
	const redirect = redirects.find((item) => item.from === pathname);

	if (redirect) {
		const statusCode = redirect.statusCode === 302 ? 302 : 301;
		return context.redirect(redirect.to, statusCode);
	}

	return next();
});

function normalizePath(value: string) {
	const normalized = value.replace(/\/$/, "");
	return normalized || "/";
}
