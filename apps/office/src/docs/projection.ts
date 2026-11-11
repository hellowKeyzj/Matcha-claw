/** Plain read DTOs matching the upstream document algorithms; no renderer imports. */
export interface DocsReadProjection {
  properties: {
    core: Record<string, string>;
    app: Record<string, string>;
    custom: Record<string, string>;
    customTypes: Record<string, string>;
  };
  notes: { kind: 'footnote' | 'endnote'; id: string; num?: number; blockIndex?: number; text: string }[];
  fields: { blockIndex: number; type: string; instr: string; result: string; dirty: boolean; protected?: true }[];
  styles: { styleId: string; name: string; type: 'paragraph' | 'character' | 'table'; basedOn?: string; headingLevel?: number; inUse: number; pending?: boolean }[];
  tableStyles: { id: string; name: string }[];
  comments: {
    id: string;
    author: string;
    initials?: string;
    date?: string;
    text: string;
    image?: { mime: 'image/png' | 'image/jpeg' | 'image/gif'; base64: string; widthPx: number; heightPx: number };
    parentId?: string;
    done?: boolean;
    paraId?: string;
    blockIndex?: number;
    anchorText?: string;
  }[];
  revisions: { id: string; type: 'insertion' | 'deletion' | 'formatting' | 'move'; kind: string; author: string; date?: string; blockIndex: number; text: string; change?: string }[];
  headerFooter: {
    header: string;
    footer: string;
    headerFirst: string | null;
    footerFirst: string | null;
    headerEven: string | null;
    footerEven: string | null;
    titlePg: boolean;
    evenOddHf: boolean;
    multiSection: boolean;
    sections: { index: number; firstBlock: number; lastBlock: number; header: string; footer: string; headerFirst: string | null; footerFirst: string | null; headerEven: string | null; footerEven: string | null }[];
    watermark: { kind: 'none'; text: null } | { kind: 'text'; text: string } | { kind: 'picture'; text: null; widthPt: number; heightPt: number; washout: boolean };
  };
}
