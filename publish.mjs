// Publishes due Instagram Reels for Lost Wonders Rebuilt, so the PC doesn't have to be on at post time.
//
// The Shorts Launcher (on the owner's PC) puts each approved post in the hidden draft release "queue":
//   post-<id>.json  { id, at (ISO UTC), caption, shareToFeed }
//   post-<id>.mp4   the video
// Every run publishes what is due, then replaces the two files with post-<id>.result.json,
// which the launcher reads back the next time it is open.
//
// Instagram can't take a direct upload from here (rupload fails for this account), so the video is put
// on the public "staging" release for the minute Instagram needs to fetch it, then deleted.

const REPO = process.env.GITHUB_REPOSITORY;
const GH = process.env.GH_TOKEN;
const IG_TOKEN = process.env.IG_ACCESS_TOKEN;
const IG_USER = process.env.IG_USER_ID;
const G = 'https://graph.facebook.com/v26.0';
const LATE_LIMIT_H = 6; // a post more than this late is reported as missed instead of posted

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gh = async (path, init = {}) => {
  const res = await fetch(path.startsWith('http') ? path : `https://api.github.com/repos/${REPO}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${GH}`, Accept: 'application/vnd.github+json', ...(init.headers ?? {}) },
  });
  if (!res.ok && res.status !== 404) throw new Error(`GitHub ${init.method ?? 'GET'} ${path}: ${res.status} ${await res.text()}`);
  return res;
};
const ig = async (path, form) => {
  const res = await fetch(`${G}${path}`, {
    method: form ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${IG_TOKEN}`, ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    body: form ? new URLSearchParams(form) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(`Instagram ${path}: ${res.status} ${data.error?.message ?? JSON.stringify(data)}`);
  return data;
};

async function release(name, { draft }) {
  const list = await (await gh('/releases?per_page=100')).json();
  return list.find((r) => r.name === name && r.draft === draft);
}
const download = async (asset) => Buffer.from(await (await gh(`/releases/assets/${asset.id}`, { headers: { Accept: 'application/octet-stream' } })).arrayBuffer());
const upload = async (rel, name, body, type) => (await gh(`https://uploads.github.com/repos/${REPO}/releases/${rel.id}/assets?name=${encodeURIComponent(name)}`, {
  method: 'POST', headers: { 'Content-Type': type }, body,
})).json();
const remove = (asset) => gh(`/releases/assets/${asset.id}`, { method: 'DELETE' });

async function publish(post, video, staging) {
  const name = `live-${post.id}-${Date.now()}.mp4`;
  const hosted = await upload(staging, name, video, 'video/mp4');
  try {
    const c = await ig(`/${IG_USER}/media`, {
      media_type: 'REELS', caption: post.caption, share_to_feed: String(post.shareToFeed !== false),
      video_url: `https://github.com/${REPO}/releases/download/staging/${encodeURIComponent(name)}`,
    });
    for (let i = 0; ; i++) {
      await sleep(5000);
      const st = await ig(`/${c.id}?fields=status_code,status`);
      if (st.status_code === 'FINISHED') break;
      if (st.status_code === 'ERROR' || st.status_code === 'EXPIRED') throw new Error(`Instagram could not process the video: ${st.status}`);
      if (i > 120) throw new Error('Instagram was still processing after 10 minutes; nothing was published.');
    }
    await remove(hosted);
    const pub = await ig(`/${IG_USER}/media_publish`, { creation_id: c.id });
    let url;
    try { url = (await ig(`/${pub.id}?fields=permalink`)).permalink; } catch { /* optional */ }
    return { status: 'posted', remoteId: pub.id, url };
  } finally {
    await remove(hosted).catch(() => {});
  }
}

const queue = await release('queue', { draft: true });
if (!queue) { console.log('No queue release yet; nothing to do.'); process.exit(0); }
const staging = await release('Staging', { draft: false });
const now = Date.now();
const jobs = queue.assets.filter((a) => /^post-\d+\.json$/.test(a.name));
console.log(`${jobs.length} queued post(s).`);

for (const meta of jobs) {
  const post = JSON.parse((await download(meta)).toString('utf8'));
  const due = new Date(post.at).getTime();
  if (due > now) { console.log(`post ${post.id}: due ${post.at}, waiting`); continue; }
  const videoAsset = queue.assets.find((a) => a.name === `post-${post.id}.mp4`);
  // Claim it first: once renamed, no later run picks it up again, even if this run dies halfway.
  await gh(`/releases/assets/${meta.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: `post-${post.id}.claimed.json` }) });
  let result;
  if (now - due > LATE_LIMIT_H * 3_600_000) {
    result = { status: 'missed', error: `More than ${LATE_LIMIT_H} h late; not posted.` };
  } else if (!videoAsset) {
    result = { status: 'error', error: 'The video file is missing from the queue.' };
  } else {
    try {
      console.log(`post ${post.id}: publishing`);
      result = await publish(post, await download(videoAsset), staging);
      console.log(`post ${post.id}: published ${result.url ?? ''}`);
    } catch (e) {
      console.log(`post ${post.id}: failed: ${e.message}`);
      result = { status: 'error', error: e.message };
    }
  }
  await upload(queue, `post-${post.id}.result.json`, JSON.stringify({ id: post.id, at: new Date().toISOString(), ...result }), 'application/json');
  await remove(meta);
  if (videoAsset) await remove(videoAsset);
}
