import { markdownToHtml } from '../../src/markdown/html.js';

// Isi <body> hasil konversi, tanpa kerangka dokumennya.
export const body = (md: string) => markdownToHtml(md, 't').split('<body>\n')[1].split('\n</body>')[0];
