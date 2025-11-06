import axios from 'axios';
import { htmlToText } from 'html-to-text';
import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type ExtractRequestBody = {
  urls: string[];
  aggregate?: boolean;
  maxChars?: number;
  includeLinks?: boolean;
};

type ExtractedResult = {
  url: string;
  title: string;
  isPdf: boolean;
  content?: string; // present when aggregate=true
  chunks?: { index: number; text: string }[]; // present when aggregate=false
  totalChunks: number;
  links?: string[]; // present when includeLinks=true and not PDF
};

const normalizeUrl = (u: string) => {
  if (u.startsWith('http://') || u.startsWith('https://')) return u;
  return `https://${u}`;
};

const extractLinksFromHtml = (html: string, baseUrl: string): string[] => {
  const hrefs: string[] = [];
  try {
    const regex = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>/gi;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(html)) !== null) {
      const raw = match[1];
      try {
        const abs = new URL(raw, baseUrl).toString();
        hrefs.push(abs);
      } catch (_) {
        // ignore invalid URLs
      }
    }
  } catch (_) {}
  // de-duplicate
  return Array.from(new Set(hrefs));
};

export const POST = async (req: Request) => {
  try {
    const body = (await req.json()) as ExtractRequestBody;

    if (!body || !Array.isArray(body.urls) || body.urls.length === 0) {
      return Response.json(
        { message: 'Missing urls array' },
        { status: 400 },
      );
    }

    const aggregate = body.aggregate !== false; // default true
    const includeLinks = body.includeLinks === true;
    const maxChars = typeof body.maxChars === 'number' ? Math.max(0, body.maxChars) : undefined;

    const splitter = new RecursiveCharacterTextSplitter();

    const results: ExtractedResult[] = await Promise.all(
      body.urls.map(async (inputUrl) => {
        const url = normalizeUrl(inputUrl.trim());
        try {
          const res = await axios.get(url, { responseType: 'arraybuffer' });
          const contentType = String(res.headers['content-type'] || '').toLowerCase();
          const isPdf = contentType.includes('application/pdf');

          if (isPdf) {
            // Lazy import to avoid bundling cost in other routes
            const pdfParse = (await import('pdf-parse')).default as unknown as (data: any) => Promise<{ text: string }>;
            const pdf = await pdfParse(res.data);
            const parsedText = pdf.text
              .replace(/(\r\n|\n|\r)/gm, ' ')
              .replace(/\s+/g, ' ')
              .trim();

            const chunks = await splitter.splitText(parsedText);
            const title = 'PDF Document';

            if (aggregate) {
              let content = chunks.join('\n\n');
              if (maxChars && content.length > maxChars) {
                content = content.slice(0, maxChars);
              }
              return {
                url,
                title,
                isPdf: true,
                content,
                totalChunks: chunks.length,
              } satisfies ExtractedResult;
            }

            const limited = maxChars
              ? (() => {
                  const out: { index: number; text: string }[] = [];
                  let used = 0;
                  for (let i = 0; i < chunks.length; i++) {
                    const remaining = maxChars - used;
                    if (remaining <= 0) break;
                    const slice = chunks[i].slice(0, Math.max(0, remaining));
                    used += slice.length;
                    out.push({ index: i, text: slice });
                  }
                  return out;
                })()
              : chunks.map((t, i) => ({ index: i, text: t }));

            return {
              url,
              title,
              isPdf: true,
              chunks: limited,
              totalChunks: chunks.length,
            } satisfies ExtractedResult;
          }

          const html = res.data.toString('utf8');
          const titleMatch = html.match(/<title.*?>(.*?)<\/title>/i);
          const title = (titleMatch && titleMatch[1]) ? titleMatch[1] : url;

          const text = htmlToText(html, {
            selectors: [
              {
                selector: 'a',
                options: { ignoreHref: true },
              },
            ],
          })
            .replace(/(\r\n|\n|\r)/gm, ' ')
            .replace(/\s+/g, ' ')
            .trim();

          const chunks = await splitter.splitText(text);

          const links = includeLinks ? extractLinksFromHtml(html, url) : undefined;

          if (aggregate) {
            let content = chunks.join('\n\n');
            if (maxChars && content.length > maxChars) {
              content = content.slice(0, maxChars);
            }
            return {
              url,
              title,
              isPdf: false,
              content,
              totalChunks: chunks.length,
              ...(includeLinks ? { links } : {}),
            } satisfies ExtractedResult;
          }

          const limited = maxChars
            ? (() => {
                const out: { index: number; text: string }[] = [];
                let used = 0;
                for (let i = 0; i < chunks.length; i++) {
                  const remaining = maxChars - used;
                  if (remaining <= 0) break;
                  const slice = chunks[i].slice(0, Math.max(0, remaining));
                  used += slice.length;
                  out.push({ index: i, text: slice });
                }
                return out;
              })()
            : chunks.map((t, i) => ({ index: i, text: t }));

          return {
            url,
            title,
            isPdf: false,
            chunks: limited,
            totalChunks: chunks.length,
            ...(includeLinks ? { links } : {}),
          } satisfies ExtractedResult;
        } catch (err: any) {
          return {
            url,
            title: 'Failed to retrieve content',
            isPdf: false,
            content: `Failed to retrieve content from the link: ${err?.message || String(err)}`,
            totalChunks: 0,
          } satisfies ExtractedResult;
        }
      }),
    );

    return Response.json({ results }, { status: 200 });
  } catch (err: any) {
    console.error('An error occurred in extract route:', err);
    return Response.json({ message: 'An error has occurred.' }, { status: 500 });
  }
};


