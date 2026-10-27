import 'dotenv/config'
import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const app = express()
const port = Number(process.env.PORT || 3001)
const apiKey = process.env.YOUTUBE_API_KEY
const channelId = process.env.YOUTUBE_CHANNEL_ID || 'UCdeGyg9ocj-F7Q-r_owLtBg'
const apiBase = 'https://www.googleapis.com/youtube/v3'
const __dirname = path.dirname(fileURLToPath(import.meta.url))

app.use(express.json())

type ApiError = { error?: { message?: string; errors?: Array<{ reason?: string }> } }
type ChannelResponse = { items?: Array<{ id: string; snippet: { title: string; description?: string; thumbnails?: Record<string, { url: string }> }; statistics: { subscriberCount?: string; videoCount?: string; viewCount?: string }; contentDetails: { relatedPlaylists: { uploads: string } } }> }
type PlaylistResponse = { items?: Array<{ snippet: { title: string; publishedAt: string; thumbnails?: Record<string, { url: string }> }; contentDetails: { videoId: string } }>; nextPageToken?: string }
type VideosResponse = { items?: Array<{ id: string; snippet: { title: string; publishedAt: string; thumbnails?: Record<string, { url: string }> }; statistics?: { viewCount?: string; likeCount?: string; commentCount?: string }; contentDetails?: { duration?: string }; status?: { privacyStatus?: 'public' | 'unlisted' | 'private' } }> }

async function youtube<T>(resource: string, params: Record<string, string>): Promise<T> {
  const url = new URL(`${apiBase}/${resource}`)
  Object.entries({ ...params, key: apiKey! }).forEach(([key, value]) => url.searchParams.set(key, value))
  const response = await fetch(url)
  const body = await response.json() as T & ApiError
  if (!response.ok) {
    const reason = body.error?.errors?.[0]?.reason
    if (reason === 'quotaExceeded') throw new Error('The YouTube Data API quota has been reached. Try again later or check your Google Cloud quota.')
    if (reason === 'keyInvalid' || reason === 'badRequest') throw new Error('The YouTube API key is invalid or not configured for YouTube Data API v3.')
    throw new Error(body.error?.message || `YouTube API request failed (${response.status}).`)
  }
  return body
}

function formatDuration(value?: string): string | null {
  if (!value) return null
  const match = value.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/)
  if (!match) return null
  const hours = Number(match[1] || 0)
  const minutes = Number(match[2] || 0)
  const seconds = Number(match[3] || 0)
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}` : `${minutes}:${String(seconds).padStart(2, '0')}`
}

function thumbnail(thumbnails?: Record<string, { url: string }>): string | null {
  return thumbnails?.medium?.url || thumbnails?.high?.url || thumbnails?.default?.url || null
}

app.get('/api/health', (_req, res) => res.json({ ok: true }))

app.get('/api/channel', async (_req, res) => {
  if (!apiKey) {
    res.status(503).json({ error: 'YouTube API is not configured. Add YOUTUBE_API_KEY to your .env file; see README.md for setup.' })
    return
  }
  try {
    const channelResult = await youtube<ChannelResponse>('channels', { part: 'snippet,statistics,contentDetails', id: channelId })
    const channel = channelResult.items?.[0]
    if (!channel) {
      res.status(404).json({ error: `No channel found for ID ${channelId}. Check YOUTUBE_CHANNEL_ID in your .env file.` })
      return
    }

    // The uploads playlist is the canonical way to enumerate every video belonging to a channel.
    // Keep requesting pages until YouTube stops returning nextPageToken.
    const playlistItems: NonNullable<PlaylistResponse['items']> = []
    let pageToken: string | undefined
    do {
      const page = await youtube<PlaylistResponse>('playlistItems', {
        part: 'snippet,contentDetails', playlistId: channel.contentDetails.relatedPlaylists.uploads,
        maxResults: '50', ...(pageToken ? { pageToken } : {}),
      })
      playlistItems.push(...(page.items || []))
      pageToken = page.nextPageToken
    } while (pageToken)

    const ids = [...new Set(playlistItems.map((item) => item.contentDetails.videoId).filter(Boolean))]
    const details: NonNullable<VideosResponse['items']> = []
    // videos.list accepts at most 50 IDs per request.
    for (let index = 0; index < ids.length; index += 50) {
      const result = await youtube<VideosResponse>('videos', { part: 'snippet,statistics,contentDetails,status', id: ids.slice(index, index + 50).join(',') })
      details.push(...(result.items || []))
    }

    const detailsById = new Map(details.map((item) => [item.id, item]))
    const refreshedAt = new Date().toISOString()
    const videos = playlistItems.flatMap((item) => {
      const id = item.contentDetails.videoId
      const detail = detailsById.get(id)
      // Video metadata may disappear between playlist enumeration and lookup. Preserve the row
      // with N/A metrics instead of silently dropping it.
      return [{
        id,
        title: detail?.snippet.title || item.snippet.title,
        publishedAt: detail?.snippet.publishedAt || item.snippet.publishedAt,
        views: detail?.statistics?.viewCount != null ? Number(detail.statistics.viewCount) : null,
        likes: detail?.statistics?.likeCount != null ? Number(detail.statistics.likeCount) : null,
        comments: detail?.statistics?.commentCount != null ? Number(detail.statistics.commentCount) : null,
        visibility: detail ? (detail.status?.privacyStatus === 'unlisted' ? 'Unlisted' : detail.status?.privacyStatus === 'private' ? 'Private' : 'Public') : 'Unavailable',
        duration: detail ? formatDuration(detail.contentDetails?.duration) : null,
        lastUpdated: refreshedAt,
        thumbnail: thumbnail(detail?.snippet.thumbnails || item.snippet.thumbnails),
        url: `https://www.youtube.com/watch?v=${id}`,
      }]
    })

    res.setHeader('Cache-Control', 'no-store')
    res.json({
      channel: {
        id: channel.id, title: channel.snippet.title, description: channel.snippet.description || '',
        thumbnail: thumbnail(channel.snippet.thumbnails),
        subscribers: channel.statistics.subscriberCount == null ? null : Number(channel.statistics.subscriberCount),
        videoCount: videos.length,
        viewCount: Number(channel.statistics.viewCount || 0),
      },
      videos,
      refreshedAt,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (message === 'fetch failed') {
      console.error('YouTube Data API network request failed:', error instanceof Error ? error.cause : 'unknown cause')
      res.status(502).json({ error: 'The backend could not reach YouTube Data API. Check your internet connection, then refresh. If it continues, check the server terminal for the network error.' })
      return
    }
    res.status(502).json({ error: message || 'Unable to fetch YouTube channel data.' })
  }
})

const clientDist = path.resolve(__dirname, '../dist')
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(clientDist))
  app.get('*', (_req, res) => res.sendFile(path.join(clientDist, 'index.html')))
}

app.listen(port, () => console.log(`YouTube analytics server listening on http://localhost:${port}`))
