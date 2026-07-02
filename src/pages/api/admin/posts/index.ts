import type { APIRoute } from "astro";
import {
	createPost,
	handleCmsError,
	jsonResponse,
	listPosts,
	requireAdmin,
	type CmsPostInput,
	type CmsEnv,
} from "../../../../lib/cms";

function envFromLocals(locals: App.Locals) {
	return (locals.runtime?.env || {}) as CmsEnv;
}

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
	try {
		const env = envFromLocals(locals);
		requireAdmin(request, env);
		const posts = await listPosts(env);
		return jsonResponse({ posts });
	} catch (error) {
		return handleCmsError(error);
	}
};

export const POST: APIRoute = async ({ request, locals }) => {
	try {
		const env = envFromLocals(locals);
		const admin = requireAdmin(request, env);
		const input = (await request.json()) as CmsPostInput;
		const post = await createPost(env, input, admin.email);
		return jsonResponse({ post }, { status: 201 });
	} catch (error) {
		return handleCmsError(error);
	}
};
