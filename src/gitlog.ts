// Mengurai keluaran git (riwayat dan diff) menjadi data. Murni, tanpa GTK dan tanpa
// memanggil git, supaya mudah diuji; pemanggilnya ada di git.ts.

export interface Commit {
    hash: string;
    short: string;
    author: string;
    time: number;          // detik sejak epoch
    subject: string;
    path: string | null;   // path file di commit ini relatif ke akar repo (berubah jika file pernah di-rename)
}

// Pemisah record dan field yang tidak mungkin muncul di pesan commit.
export const LOG_FORMAT = '%x1e%H%x1f%h%x1f%an%x1f%at%x1f%s';

// Keluaran `git log --name-only --format=LOG_FORMAT`: tiap commit diawali \x1e,
// baris pertamanya field commit, sisanya nama file.
export function parseLog(output: string): Commit[] {
    const commits: Commit[] = [];
    for (const record of output.split('\x1e')) {
        if (!record.trim()) continue;
        const [head, ...rest] = record.split('\n');
        const [hash, short, author, time, ...subject] = head.split('\x1f');
        if (!hash || !short) continue;
        const path = rest.find(line => line.trim() !== '') ?? null;
        // Path dengan karakter khusus dikutip git (diawali "); jangan dipakai mentah-mentah.
        commits.push({
            hash, short, author, time: Number(time) || 0, subject: subject.join('\x1f'),
            path: path && !path.startsWith('"') ? path : null,
        });
    }
    return commits;
}

const MINUTE = 60, HOUR = 3600, DAY = 86400;

// "3 hari lalu", "2 bulan lalu", ...
export function relativeTime(time: number, now: number): string {
    const diff = Math.max(0, now - time);
    if (diff < MINUTE) return 'baru saja';
    if (diff < HOUR) return `${Math.floor(diff / MINUTE)} menit lalu`;
    if (diff < DAY) return `${Math.floor(diff / HOUR)} jam lalu`;
    if (diff < 7 * DAY) return `${Math.floor(diff / DAY)} hari lalu`;
    if (diff < 30 * DAY) return `${Math.floor(diff / (7 * DAY))} minggu lalu`;
    if (diff < 365 * DAY) return `${Math.floor(diff / (30 * DAY))} bulan lalu`;
    return `${Math.floor(diff / (365 * DAY))} tahun lalu`;
}

export type DiffKind = 'add' | 'del' | 'hunk' | 'context';

export interface DiffLine { kind: DiffKind; text: string }

// Keluaran `git show` untuk satu file → baris berjenis. Kepala diff (diff --git, index,
// ---, +++) dibuang; isinya sudah ada di judul jendela, jadi hanya mengganggu bacaan.
export function parseDiff(output: string): DiffLine[] {
    const lines = output.replace(/\n$/, '').split('\n');
    const firstHunk = lines.findIndex(line => line.startsWith('@@'));
    const body = firstHunk < 0 ? [] : lines.slice(firstHunk);
    return body.map(text => {
        if (text.startsWith('@@')) return { kind: 'hunk', text };
        if (text.startsWith('+')) return { kind: 'add', text };
        if (text.startsWith('-')) return { kind: 'del', text };
        return { kind: 'context', text };
    });
}
