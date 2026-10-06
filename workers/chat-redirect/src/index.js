const WHATSAPP_URL =
	"https://wa.me/628117229979?text=Halo%20Mas%20Aruna%2C%20saya%20%28nama%20anda%29%2C%20saya%20butuh%20bantuan%20ini%3A%20%28silahkan%20isi%29";

export default {
	fetch() {
		return new Response(null, {
			status: 302,
			headers: {
				Location: WHATSAPP_URL,
				"Cache-Control": "no-store",
				"X-Content-Type-Options": "nosniff",
			},
		});
	},
};
