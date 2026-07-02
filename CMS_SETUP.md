# Setup CMS Blog

CMS tersedia di `/admin` dan menyimpan artikel sebagai file Markdown di GitHub.

## 1. Cloudflare Access

Buat aplikasi Cloudflare Access untuk:

- `https://arunajr.com/admin*`
- `https://arunajr.com/api/admin/*`

Izinkan hanya email admin yang boleh mengelola artikel.

## 2. Worker Secrets

Tambahkan secret berikut ke Cloudflare Worker:

```bash
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put CMS_ALLOWED_EMAILS
```

Isi `GITHUB_TOKEN` dengan fine-grained GitHub token yang hanya punya akses ke repo ini.

Isi `CMS_ALLOWED_EMAILS` dengan email admin, pisahkan koma jika lebih dari satu:

```text
nama@email.com,email2@email.com
```

## 3. GitHub Actions Secrets

Tambahkan repository secrets di GitHub:

- `CLOUDFLARE_API_KEY`
- `CLOUDFLARE_EMAIL`
- `CLOUDFLARE_ACCOUNT_ID`

Setelah itu, setiap push ke branch `main` akan menjalankan build dan deploy otomatis.

## 4. Cara Pakai

1. Buka `https://arunajr.com/admin`.
2. Login lewat Cloudflare Access.
3. Pilih artikel atau buat post baru.
4. Isi judul, slug, tanggal, deskripsi, gambar, dan isi artikel.
5. Klik `Save Draft` untuk menyimpan tanpa tampil publik.
6. Klik `Publish` untuk menampilkan artikel di website setelah deploy.

CMS akan membuat commit ke GitHub. GitHub Actions lalu deploy otomatis ke Cloudflare.
