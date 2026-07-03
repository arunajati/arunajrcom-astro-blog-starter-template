import type { APIRoute } from "astro";
import {
	cleanupTemporaryUploads,
	handleCmsError,
	jsonResponse,
	requireAdmin,
	type CmsEnv,
} from "../../../../lib/cms";

function envFromLocals(locals: App.Locals) {
	return (locals.runtime?.env || {}) as CmsEnv;
}

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
	try {
		const env = envFromLocals(locals);
		const admin = requireAdmin(request, env);
		const cleanup = await cleanupTemporaryUploads(env, admin.email);
		return jsonResponse({ cleanup });
	} catch (error) {
		return handleCmsError(error);
	}
};
