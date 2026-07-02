import type { APIRoute } from "astro";
import {
	getPost,
	handleCmsError,
	jsonResponse,
	requireAdmin,
	updatePost,
	type CmsPostInput,
	type CmsEnv,
} from "../../../../lib/cms";

function envFromLocals(locals: App.Locals) {
	return (locals.runtime?.env || {}) as CmsEnv;
}

export const prerender = false;

export const GET: APIRoute = async ({ request, locals, params }) => {
	try {
		const env = envFromLocals(locals);
		requireAdmin(request, env);
		const post = await getPost(env, params.slug || "");
		return jsonResponse({ post });
	} catch (error) {
		return handleCmsError(error);
	}
};

export const PUT: APIRoute = async ({ request, locals, params }) => {
	try {
		const env = envFromLocals(locals);
		const admin = requireAdmin(request, env);
		const input = (await request.json()) as CmsPostInput;
		const post = await updatePost(env, params.slug || "", input, admin.email);
		return jsonResponse({ post });
	} catch (error) {
		return handleCmsError(error);
	}
};
