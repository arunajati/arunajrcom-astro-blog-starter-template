import type { APIRoute } from "astro";
import {
	handleCmsError,
	jsonResponse,
	requireAdmin,
	uploadImage,
	type CmsEnv,
} from "../../../lib/cms";

function envFromLocals(locals: App.Locals) {
	return (locals.runtime?.env || {}) as CmsEnv;
}

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
	try {
		const env = envFromLocals(locals);
		const admin = requireAdmin(request, env);
		const form = await request.formData();
		const file = form.get("file");

		if (!(file instanceof File)) {
			return jsonResponse({ error: "File gambar wajib diisi." }, { status: 400 });
		}

		const upload = await uploadImage(env, file, admin.email, String(form.get("slug") || ""));
		return jsonResponse({ upload }, { status: 201 });
	} catch (error) {
		return handleCmsError(error);
	}
};
