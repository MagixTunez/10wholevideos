configure the .env to ur liking

basehost - forcing absolute urls so it doesn't have to auto detect host headers and it just lots more secure, I wouldn't change this as the domain is set ingame and would require a rebuild I thinkkk???? so just keep it the way it is (:

segmentDuration - target HLS segment length in seconds, lower values reduce latency but increase requests

segmentQueueConcurrency - max concurrent segment generation jobs for the non native path. This is rlly small but you can mess with it if you want

useNativeHls - bool, using the ffmpeg HLS pipeline. This adds alot to the stability and would advise against changing it. It can mess with fetching segments in order and that will fuck up alot

nativeHlsListSize - number of segments kept in the live playlist window by ffmpeg. After the amount set it will kill the segments. Don't set this too high

hlsProgramDateTime - EXT-X-PROGRAM-DATE-TIME tags for segment TPS

enableNativePlaylistSyncRewrite - turns OFF server-side playlist rewriting.
0 = serve FFmpeg playlist as-is (safer), 1 = rewrite for tighter multi-client sync

syncLiveWindowSegments -
Only used when enableNativePlaylistSyncRewrite=1.
How many newest segments to keep in rewritten playlist.

hardSyncStartOffsetSeconds -
Only used when enableNativePlaylistSyncRewrite=1.
Adds an HLS start offset so clients begin near the same point in the vod (for the vine)
