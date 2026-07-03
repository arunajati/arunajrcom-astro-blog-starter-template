import type { APIRoute } from "astro";
import {
	deleteRedirect,
	handleCmsError,
	jsonResponse,
	requireAdmin,
	updateRedirect,
	type CmsEnv,
	type CmsRedirectInput,
} from "../../../../lib/cms";

function envFromLocals(locals: App.Locals) {
	return (locals.runtime?.env || {}) as CmsEnv;
}

export const prerender = false;

export const PUT: APIRoute = async ({ request, locals, params }) => {
	try {
		const env = envFromLocals(locals);
		const admin = requireAdmin(request, env);
		const input = (await request.json()) as CmsRedirectInput;
		const data = await updateRedirect(env, params.id || "", input, admin.email);
		return jsonResponse(data);
	} catch (error) {
		return handleCmsError(error);
	}
};

export const DELETE: APIRoute = async ({ request, locals, params }) => {
	try {
		const env = envFromLocals(locals);
		const admin = requireAdmin(request, env);
		const data = await deleteRedirect(env, params.id || "", admin.email);
		return jsonResponse(data);
	} catch (error) {
		return handleCmsError(error);
	}
};
