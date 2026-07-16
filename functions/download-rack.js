// Cloudflare Pages Function: /download-rack
// Streams the paddle-rack video from R2 through our own domain with a
// Content-Disposition: attachment header so browsers force a real download
// instead of playing it inline/fullscreen. Sidesteps the cross-origin
// download limitation on the raw r2.dev URL.
const VIDEO_URL =
  'https://pub-d884496adff243c08bda3301b36cb50f.r2.dev/Web%20Videos/Court%20Rack%20Video%20lowres%20.mp4';

export async function onRequest(context) {
  const range = context.request.headers.get('Range');
  const upstream = await fetch(VIDEO_URL, {
    headers: range ? { Range: range } : {},
  });

  const headers = new Headers(upstream.headers);
  headers.set('Content-Type', 'video/mp4');
  headers.set(
    'Content-Disposition',
    'attachment; filename="LevelUp-Paddle-Rack.mp4"'
  );
  headers.set('Cache-Control', 'public, max-age=3600');

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}
