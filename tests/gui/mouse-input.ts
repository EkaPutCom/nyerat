// Klien X11 kecil untuk tes: koneksi Gio, autentikasi Xauthority, lalu XTEST.
// Encoding FakeInput: https://xorg.freedesktop.org/archive/X11R7.6/doc/xextproto/xtest.html
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const padded = (n: number) => (n + 3) & ~3;
const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

// Cookie hanya dipakai untuk handshake; jangan masukkan isinya ke pesan galat.
function authority(number: string): Uint8Array {
    const path = GLib.getenv('XAUTHORITY') || GLib.build_filenamev([GLib.get_home_dir(), '.Xauthority']);
    if (!GLib.file_test(path, GLib.FileTest.EXISTS)) return new Uint8Array();
    const [success, bytes] = GLib.file_get_contents(path);
    if (!success) throw new Error('Tidak bisa membaca Xauthority.');
    const data = view(bytes);
    let offset = 0;
    const word = () => {
        if (offset + 2 > bytes.length) throw new Error('Format Xauthority terpotong.');
        const value = data.getUint16(offset); offset += 2;
        return value;
    };
    const field = () => {
        const length = word();
        if (offset + length > bytes.length) throw new Error('Format Xauthority terpotong.');
        const result = bytes.slice(offset, offset + length); offset += length;
        return result;
    };
    const decode = (value: Uint8Array) => new TextDecoder().decode(value);
    let local: Uint8Array | undefined;
    while (offset < bytes.length) {
        const family = word(), address = field(), display = field(), name = field(), cookie = field();
        if (decode(display) !== number || decode(name) !== 'MIT-MAGIC-COOKIE-1') continue;
        if (family === 256 && decode(address) === GLib.get_host_name()) return cookie;
        if (family === 256 || family === 65535) local = cookie;
    }
    return local ?? new Uint8Array();
}

export class MouseInput {
    private connection: Gio.SocketConnection;
    private root = 0;
    private opcode = 0;

    constructor() {
        const display = GLib.getenv('DISPLAY') ?? '';
        const match = /^(?:unix)?:([0-9]+)(?:\.([0-9]+))?$/.exec(display);
        if (!match) throw new Error('Input mouse membutuhkan DISPLAY X11 lokal, misalnya :0 atau :0.0.');
        const cookie = authority(match[1]);
        const client = new Gio.SocketClient({ timeout: 3, enable_proxy: false });
        this.connection = client.connect(Gio.UnixSocketAddress.new(`/tmp/.X11-unix/X${match[1]}`), null);
        try {
            const name = cookie.length ? new TextEncoder().encode('MIT-MAGIC-COOKIE-1') : new Uint8Array();
            const setup = new Uint8Array(12 + padded(name.length) + padded(cookie.length));
            setup[0] = 108; // 'l': bilangan little-endian, versi protokol 11.0.
            const header = view(setup);
            header.setUint16(2, 11, true);
            header.setUint16(6, name.length, true);
            header.setUint16(8, cookie.length, true);
            setup.set(name, 12); setup.set(cookie, 12 + padded(name.length));
            this.write(setup);
            const prefix = this.read(8);
            const body = this.read(view(prefix).getUint16(6, true) * 4);
            if (prefix[0] !== 1) throw new Error('Server X11 menolak koneksi; periksa DISPLAY dan XAUTHORITY.');
            const setupView = view(body);
            let screen = 32 + padded(setupView.getUint16(16, true)) + body[21] * 8;
            const wanted = Number(match[2] ?? 0);
            if (wanted >= body[20]) throw new Error('Layar DISPLAY tidak tersedia.');
            for (let i = 0; i < wanted; i++) {
                const depths = body[screen + 39];
                screen += 40;
                for (let j = 0; j < depths; j++) screen += 8 + setupView.getUint16(screen + 2, true) * 24;
            }
            this.root = setupView.getUint32(screen, true);
            const extension = new TextEncoder().encode('XTEST');
            const query = this.request(98, 0, 8 + padded(extension.length));
            view(query).setUint16(4, extension.length, true); query.set(extension, 8);
            this.write(query);
            const reply = this.reply();
            if (!reply[8]) throw new Error('Display X11 tidak mendukung XTest.');
            this.opcode = reply[9];
            const version = this.request(this.opcode, 0, 8);
            version[4] = 2; view(version).setUint16(6, 2, true);
            this.write(version); this.reply();
        } catch (error) {
            this.close();
            throw error;
        }
    }

    private read(size: number): Uint8Array {
        const bytes = new Uint8Array(size);
        let offset = 0;
        while (offset < size) {
            const part = this.connection.get_input_stream().read_bytes(size - offset, null).get_data();
            if (!part?.length) throw new Error('Koneksi input X11 terputus.');
            bytes.set(part, offset); offset += part.length;
        }
        return bytes;
    }

    private write(bytes: Uint8Array): void {
        const [success, count] = this.connection.get_output_stream().write_all(bytes, null);
        if (!success || count !== bytes.length) throw new Error('Gagal mengirim input X11.');
    }

    private request(opcode: number, minor: number, size: number): Uint8Array {
        const bytes = new Uint8Array(size);
        bytes[0] = opcode; bytes[1] = minor;
        view(bytes).setUint16(2, size / 4, true);
        return bytes;
    }

    private reply(): Uint8Array {
        const bytes = this.read(32);
        if (bytes[0] === 0) throw new Error(`Server X11 menolak permintaan (kode ${bytes[1]}, opcode ${bytes[10]}).`);
        if (bytes[0] !== 1) throw new Error('Balasan X11 tidak sesuai protokol.');
        const extra = view(bytes).getUint32(4, true) * 4;
        if (extra) this.read(extra);
        return bytes;
    }

    position(): readonly [number, number] {
        const query = this.request(38, 0, 8);
        view(query).setUint32(4, this.root, true);
        this.write(query);
        const reply = this.reply(), data = view(reply);
        if (!reply[1]) throw new Error('Pointer berada di layar X11 lain.');
        if (data.getUint16(24, true) & 0x1f00) throw new Error('Lepaskan semua tombol mouse sebelum menjalankan tes.');
        return [data.getInt16(16, true), data.getInt16(18, true)];
    }

    private fake(type: number, detail: number, x = 0, y = 0): void {
        const request = this.request(this.opcode, 2, 36), data = view(request);
        request[4] = type; request[5] = detail;
        data.setUint32(12, this.root, true);
        data.setInt16(24, x, true); data.setInt16(26, y, true);
        this.write(request);
        // GetInputFocus menjadi penghalang: server telah memproses FakeInput sebelum
        // mengirim balasannya. Galat protokol juga tidak bisa menghasilkan lulus palsu.
        this.write(this.request(43, 0, 4)); this.reply();
    }

    move(x: number, y: number): void {
        const rx = Math.round(x), ry = Math.round(y);
        if (!Number.isFinite(rx) || !Number.isFinite(ry) || rx < -32768 || rx > 32767 || ry < -32768 || ry > 32767)
            throw new Error('Koordinat pointer di luar rentang X11.');
        this.fake(6, 0, rx, ry);
    }

    // Posisi (x, y) di jendela X11 `xid` dalam koordinat layar (TranslateCoordinates).
    toRoot(xid: number, x: number, y: number): [number, number] {
        const request = this.request(40, 0, 16), data = view(request);
        data.setUint32(4, xid, true);
        data.setUint32(8, this.root, true);
        data.setInt16(12, Math.round(x), true);
        data.setInt16(14, Math.round(y), true);
        this.write(request);
        const reply = view(this.reply());
        return [reply.getInt16(12, true), reply.getInt16(14, true)];
    }

    down(): void { this.fake(4, 1); }
    up(): void { this.fake(5, 1); }
    close(): void { this.connection.close(null); }
}
