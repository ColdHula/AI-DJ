# AI DJ

Aplikasi DJ di browser untuk orang yang suka musik DJ tapi belum pernah nge-DJ. AI yang menjaga ketukan, menyusun bagian lagu (intro, build up, drop, break), dan memberi tahu tombol apa yang ditekan berikutnya. Tombol apa pun yang ditekan selalu masuk tepat di ketukan, jadi hasilnya tetap enak didengar.

## Cara pakai

1. Buka `index.html` di Chrome (HP atau laptop). Tidak perlu install apa pun.
2. Pilih genre, tekan **MAIN**.
3. Ikuti tulisan besar di layar. Tombol yang harus ditekan akan berkedip.
4. Mau remix lagu sendiri? Masukkan file MP3/WAV. AI mencari tempo, ketukan pertama, dan kunci nada, lalu beat menyesuaikan.
5. Tekan **Rekam** untuk menyimpan hasil set (format WebM/MP4).

## Fitur

- 13 genre: Jedag Jedug, Breakbeat Remix Indo, Funkot, Koplo Remix, Hipdut, DJ Slow Bass, Horeg Cek Sound, Jungle Dutch, Melbourne Bounce, Big Room, Brazilian Phonk, Amapiano, Afro House.
- 16 tombol: Build Up, Drop, Break, Echo Out, Air Horn, Sirene, Laser, Boom, Roll, Scratch, Rewind, Fill, Bass Dive, Cek Sound, Tepuk, Variasi.
- **AI Pilot**: bagian lagu berganti otomatis. Kalau dimatikan, bagian lagu berulang sampai kamu menekan tombol transisi.
- **Pelatih**: arahan tombol berikutnya, skor dan combo.
- **FX Pad**: geser untuk filter, gema dan ruang. Lepas jari, suara kembali normal.
- Semua suara dibuat langsung di browser (Web Audio), tanpa sampel berhak cipta.

## Update genre otomatis

Semua genre ada di `genres.js` (isi di antara kurung kurawal adalah JSON murni). Saat dibuka, aplikasi mengecek `updateUrls` di file itu. Kalau ada versi lebih baru (`version` lebih besar), genre baru langsung masuk dan ditandai **Baru**.

Untuk menambah genre: salin satu blok genre, ganti `id`, `name`, `bpm`, pola drum, bass, akor dan melodi, lalu naikkan `version` dan `updated`. Bisa juga impor file paket lewat tombol **Impor paket**.

Notasi pola (16 langkah per bar):

- Drum: `X` keras, `x` normal, `g` pelan, `.` diam. Perkusi: `d` dut, `t` tak, `k` ket (kendang), `m` tom, `r` rim, `s` shaker, `b` bongo, `n` conga, `w` cowbell.
- Bass: angka = semitone dari akar akor, `-` tahan, `.` diam.
- Melodi: angka = derajat tangga nada (1 = tonika, 8 = oktaf), `-` tahan, `.` diam.

## Build satu file

`node build.js` menghasilkan `dist/ai-dj.html` yang semua skripnya sudah digabung.
