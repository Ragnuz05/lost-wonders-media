# lost-wonders-media

Publishing helper for the Lost Wonders Rebuilt channel.

- `publish.mjs` and `.github/workflows/publish.yml` run every 15 minutes and publish due Instagram Reels, so the channel's PC doesn't need to be on at post time. The queue is a draft release (not public); the Instagram token is an encrypted repository secret.
- The `staging` release holds each video only for the minute Instagram takes to fetch it; it is deleted right after.
