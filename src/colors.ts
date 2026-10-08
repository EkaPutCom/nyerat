// Document surface colors for light and dark mode. Pure data, shared by editor/ and ui/ without pulling in Adw;
// ui/theme.ts turns a palette into the app CSS.

export interface Palette {
    bg: string; fg: string; heading: string; faint: string; dim: string;
    accent: string; codeBg: string; codeFg: string; quoteFg: string;
    quoteBg: string; markBg: string; sel: string; sideBg: string;
    codeScheme: string;  // GtkSourceView color scheme for code block contents
    columnBg: string;    // background of lists on the kanban board
    dark: boolean;
}

export const PALETTES: Record<'light' | 'dark', Palette> = {
    light: {
        bg: '#ffffff', fg: '#333333', heading: '#1f2328', faint: '#b4b9bf', dim: '#cdd1d5',
        accent: '#1c71d8', codeBg: '#f3f4f4', codeFg: '#c7254e', quoteFg: '#6a737d',
        quoteBg: '#f7f7f9', markBg: '#fff3a3', sel: '#b3d4fc', sideBg: '#f7f7f7',
        codeScheme: 'tango',
        columnBg: '#e9ebef',
        dark: false,
    },
    dark: {
        bg: '#1e1e1e', fg: '#d4d4d4', heading: '#f0f0f0', faint: '#5f6368', dim: '#46494e',
        accent: '#78aeed', codeBg: '#2b2d31', codeFg: '#f78c6c', quoteFg: '#9aa0a6',
        quoteBg: '#26282c', markBg: '#6b5a12', sel: '#264f78', sideBg: '#18191b',
        codeScheme: 'cobalt',
        columnBg: '#2b2d31',
        dark: true,
    },
};
