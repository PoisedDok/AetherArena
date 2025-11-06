export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Body = {
  url: string;
};

const normalizeUrl = (u: string) => {
  if (u.startsWith('http://') || u.startsWith('https://')) return u;
  return `https://${u}`;
};

export const POST = async (req: Request) => {
  try {
    const body = (await req.json()) as Body;
    const inputUrl = (body?.url || '').trim();
    if (!inputUrl) {
      return Response.json({ message: 'Missing url' }, { status: 400 });
    }

    const url = normalizeUrl(inputUrl);
    const res = await fetch(url);
    const html = await res.text();

    const hrefs: string[] = [];
    try {
      const regex = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>/gi;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(html)) !== null) {
        const raw = match[1];
        try {
          const abs = new URL(raw, url).toString();
          hrefs.push(abs);
        } catch (_) {}
      }
    } catch (_) {}

    const unique = Array.from(new Set(hrefs));

    return Response.json({ url, links: unique, count: unique.length }, { status: 200 });
  } catch (err: any) {
    console.error('An error occurred in links route:', err);
    return Response.json({ message: 'An error has occurred.' }, { status: 500 });
  }
};


