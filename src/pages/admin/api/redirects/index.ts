import type { APIRoute } from "astro";
import {
	createRedirect,
	handleCmsError,
	jsonResponse,
	listRedirects,
	requireAdmin,
	type CmsEnv,
	type CmsRedirectInput,
} from "../../../../lib/cms";

function envFromLocals(locals: App.Locals) {
	return (locals.runtime?.env || {}) as CmsEnv;
}

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
	try {
		const env = envFromLocals(locals);
		requireAdmin(request, env);
		const redirects = await listRedirects(env);
		return jsonResponse(redirects);
	} catch (error) {
		return handleCmsError(error);
	}
};

export const POST: APIRoute = async ({ request, locals }) => {
	try {
		const env = envFromLocals(locals);
		const admin = requireAdmin(request, env);
		const input = (await request.json()) as CmsRedirectInput;
		const data = await createRedirect(env, input, admin.email);
		return jsonResponse(data, { status: 201 });
	} catch (error) {
		return handleCmsError(error);
	}
};
