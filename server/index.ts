import 'dotenv/config'
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import express from 'express'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const app = express()
const port = Number(process.env.PORT || 3001)
const host = process.env.HOST || '127.0.0.1'
const apiKey = process.env.YOUTUBE_API_KEY
const defaultChannelId = process.env.YOUTUBE_CHANNEL_ID || ''
const apiBase = 'https://www.googleapis.com/youtube/v3'
const oauthClientId = process.env.GOOGLE_OAUTH_CLIENT_ID
const oauthClientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET
const scrypt = promisify(scryptCallback)
const appDataDir = process.env.APP_CONFIG_DIR || (process.platform === 'win32'
  ? path.join(process.env.APPDATA || os.homedir(), 'MyYoutubeRecord')
  : path.join(os.homedir(), '.config', 'MyYoutubeRecord'))
const setupFile = path.join(appDataDir, 'setup.json')
const logoutFile = path.join(appDataDir, 'logout.json')
let invalidSavedSetup = false

type SetupConfig = {
  completed: true
  channelId: string
  channelName: string
  channelUrl: string
  channelThumbnail?: string | null
  verifiedEmail: string
  googleSubject: string
  passwordSalt?: string
  passwordHash?: string
  createdAt: string
}
type OAuthAttempt = {
  state: string
  verifier: string
  redirectUri: string
  expiresAt: number
  purpose: 'setup' | 'reset' | 'login'
}
type AccessibleChannel = { id: string; name: string; thumbnail: string | null }
type VerifiedSetup = {
  channels: AccessibleChannel[]
  email: string
  subject: string
  expiresAt: number
}

async function readSetup(): Promise<SetupConfig | null> {
  let raw: string
  try {
    raw = await fs.readFile(setupFile, 'utf8')
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null
    invalidSavedSetup = true
    return null
  }

  try {
    const value = JSON.parse(raw) as Partial<SetupConfig>
    const channelIdIsValid = typeof value.channelId === 'string' && /^UC[A-Za-z0-9_-]{20,30}$/.test(value.channelId)
    const channelUrlIsValid = typeof value.channelUrl === 'string' && value.channelUrl.length <= 500 && (() => {
      try { return ['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(new URL(value.channelUrl!).hostname.toLowerCase()) }
      catch { return false }
    })()
    const hasPassword = value.passwordSalt !== undefined || value.passwordHash !== undefined
    const passwordIsValid = hasPassword
      ? typeof value.passwordSalt === 'string' && Buffer.from(value.passwordSalt, 'base64url').length === 16
        && typeof value.passwordHash === 'string' && Buffer.from(value.passwordHash, 'base64').length === 64
      : true
    const isValid = value.completed === true
      && channelIdIsValid
      && typeof value.channelName === 'string' && value.channelName.trim().length > 0
      && channelUrlIsValid
      && typeof value.verifiedEmail === 'string' && value.verifiedEmail.includes('@')
      && typeof value.googleSubject === 'string' && value.googleSubject.length > 0
      && passwordIsValid
      && typeof value.createdAt === 'string' && !Number.isNaN(Date.parse(value.createdAt))
    if (isValid) return value as SetupConfig
  } catch {
    // Preserve malformed setup data and show setup instead of accepting it as complete.
  }
  invalidSavedSetup = true
  return null
}

async function readLogoutState(): Promise<boolean> {
  try {
    await fs.access(logoutFile)
    return true
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false
    return true
  }
}

let setupConfig: SetupConfig | null = null
let channelId = defaultChannelId
let oauthAttempt: OAuthAttempt | null = null
let verifiedSetup: VerifiedSetup | null = null
let verifiedPurpose: OAuthAttempt['purpose'] | null = null
let setupError = ''
let setupBusy = false
let loggedOut = false
let server: ReturnType<typeof app.listen> | undefined

app.use(express.json())

function setupErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Setup could not be completed. Please try again.'
}

function isValidState(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual)
  const expectedBytes = Buffer.from(expected)
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
}

app.get('/api/setup/status', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  res.json({
    configured: Boolean(setupConfig?.completed && !loggedOut),
    loggedOut,
    channelName: setupConfig?.channelName,
    verifiedEmail: setupConfig?.verifiedEmail,
    requiresPasswordForReset: Boolean(setupConfig?.passwordHash),
    issue: invalidSavedSetup ? 'An existing setup.json is invalid and was preserved. Back it up before configuring this profile again.' : undefined,
  })
})

app.post('/api/setup/google/start', async (req, res) => {
  const purpose = req.body?.purpose === 'reset' ? 'reset' : req.body?.purpose === 'login' ? 'login' : 'setup'
  if (purpose === 'setup' && setupConfig?.completed) return res.status(409).json({ error: 'This user profile is already configured.' })
  if (purpose === 'reset' && !setupConfig?.completed) return res.status(409).json({ error: 'This user profile is not configured.' })
  if (purpose === 'login' && (!setupConfig?.completed || !loggedOut)) return res.status(409).json({ error: 'Log out from the dashboard before signing in again.' })
  if (invalidSavedSetup) return res.status(409).json({ error: 'An existing setup.json is invalid and was preserved. Back it up before configuring this profile again.' })
  if (!oauthClientId) return res.status(503).json({ error: 'Google OAuth is not configured. Add GOOGLE_OAUTH_CLIENT_ID for a Google Desktop OAuth client to your app .env file.' })
  try {
    const address = server?.address()
    if (!address || typeof address === 'string') throw new Error('The local callback server is not ready.')
    const redirectUri = `http://127.0.0.1:${address.port}`
    const state = randomBytes(32).toString('base64url')
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    oauthAttempt = { state, verifier, redirectUri, expiresAt: Date.now() + 10 * 60_000, purpose }
    verifiedSetup = null
    verifiedPurpose = null
    setupError = ''
    const authorizationUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    authorizationUrl.search = new URLSearchParams({
      client_id: oauthClientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile https://www.googleapis.com/auth/youtube.readonly',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      access_type: 'online',
      prompt: 'select_account',
    }).toString()
    res.setHeader('Cache-Control', 'no-store')
    res.json({ authorizationUrl: authorizationUrl.toString() })
  } catch (error) {
    res.status(400).json({ error: setupErrorMessage(error) })
  }
})

app.get('/api/setup/google/status', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  if (verifiedSetup && verifiedSetup.expiresAt > Date.now()) {
    return res.json({ status: 'verified', email: verifiedSetup.email, channels: verifiedSetup.channels })
  }
  if (verifiedSetup && verifiedSetup.expiresAt <= Date.now()) verifiedSetup = null
  if (setupError) return res.json({ status: 'error', error: setupError })
  if (oauthAttempt && oauthAttempt.expiresAt <= Date.now()) {
    oauthAttempt = null
    setupError = 'Google verification timed out. Please connect your account again.'
    return res.json({ status: 'error', error: setupError })
  }
  res.json({ status: oauthAttempt ? 'pending' : 'idle' })
})

app.get('/', async (req, res, next) => {
  if (typeof req.query.state !== 'string' && typeof req.query.code !== 'string' && typeof req.query.error !== 'string') return next()
  const attempt = oauthAttempt
  const state = typeof req.query.state === 'string' ? req.query.state : ''
  const code = typeof req.query.code === 'string' ? req.query.code : ''

  const finishPage = (message: string) => res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><title>MyYoutubeRecord setup</title></head><body style="font:16px system-ui;max-width:600px;margin:12vh auto;padding:24px;color:#252b2a"><h1>${message}</h1><p>Return to MyYoutubeRecord to continue setup.</p></body></html>`)
  if (!attempt) return finishPage('Verification was not accepted')
  if (attempt.expiresAt <= Date.now()) {
    oauthAttempt = null
    setupError = 'Google verification timed out. Please connect your account again.'
    return finishPage('Verification was not accepted')
  }
  if (!isValidState(state, attempt.state)) {
    setupError = 'Google verification could not be matched to this setup. Please connect your account again.'
    return finishPage('Verification was not accepted')
  }
  oauthAttempt = null
  verifiedPurpose = null
  if (typeof req.query.error === 'string' || !code) {
    const googleError = typeof req.query.error === 'string' ? req.query.error : ''
    setupError = googleError === 'access_denied'
      ? 'Google blocked this account because the OAuth app is in Testing mode. Add this email under Google Cloud Console → Google Auth Platform → Audience → Test users, or publish and complete verification for the app to allow other accounts.'
      : 'Google account connection was cancelled or denied.'
    return finishPage('Google account was not connected')
  }

  try {
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: oauthClientId!,
        ...(oauthClientSecret ? { client_secret: oauthClientSecret } : {}),
        code,
        code_verifier: attempt.verifier,
        grant_type: 'authorization_code',
        redirect_uri: attempt.redirectUri,
      }),
    })
    const tokenBody = await tokenResponse.json() as { access_token?: string; error_description?: string }
    if (!tokenResponse.ok || !tokenBody.access_token) throw new Error(tokenBody.error_description || 'Google did not return an access token.')

    const identityResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${tokenBody.access_token}` },
    })
    const identity = await identityResponse.json() as { email?: string; email_verified?: boolean; sub?: string }
    if (!identityResponse.ok || !identity.email || identity.email_verified !== true || !identity.sub) {
      throw new Error('Google did not provide a verified email address for this account.')
    }

    const channels: Array<{ id: string; snippet?: { title?: string; thumbnails?: Record<string, { url?: string }> } }> = []
    let pageToken = ''
    do {
      const query = new URLSearchParams({ part: 'id,snippet', mine: 'true', maxResults: '50', ...(pageToken ? { pageToken } : {}) })
      const channelsResponse = await fetch(`${apiBase}/channels?${query}`, {
        headers: { Authorization: `Bearer ${tokenBody.access_token}` },
      })
      const channelBody = await channelsResponse.json() as {
        items?: Array<{ id: string; snippet?: { title?: string; thumbnails?: Record<string, { url?: string }> } }>
        nextPageToken?: string
        error?: { message?: string }
      }
      if (!channelsResponse.ok) throw new Error(channelBody.error?.message || 'YouTube could not verify channels for this Google account.')
      channels.push(...(channelBody.items || []))
      pageToken = channelBody.nextPageToken || ''
    } while (pageToken)

    const accessibleChannels: AccessibleChannel[] = channels.map((channel) => ({
      id: channel.id,
      name: channel.snippet?.title?.trim() || 'YouTube channel',
      thumbnail: channel.snippet?.thumbnails?.high?.url || channel.snippet?.thumbnails?.medium?.url || channel.snippet?.thumbnails?.default?.url || null,
    }))
    if (accessibleChannels.length === 0) throw new Error('No accessible YouTube channels were found for this Google account.')
    verifiedSetup = {
      channels: accessibleChannels,
      email: identity.email,
      subject: identity.sub,
      expiresAt: Date.now() + 10 * 60_000,
    }
    verifiedPurpose = attempt.purpose
    setupError = ''
    // The OAuth token is intentionally kept only in this callback scope and is never persisted or sent to the renderer.
    delete tokenBody.access_token
    return finishPage('Google account verified')
  } catch (error) {
    verifiedSetup = null
    verifiedPurpose = null
    setupError = setupErrorMessage(error)
    return finishPage('Google account could not be verified')
  }
})

app.post('/api/setup/complete', async (req, res) => {
  if (setupConfig?.completed) return res.status(409).json({ error: 'This user profile is already configured.' })
  if (invalidSavedSetup) return res.status(409).json({ error: 'An existing setup.json is invalid and was preserved. Back it up before configuring this profile again.' })
  if (!verifiedSetup || verifiedSetup.expiresAt <= Date.now() || verifiedPurpose !== 'setup') return res.status(403).json({ error: 'Connect and verify your Google account before saving setup.' })
  const selectedChannelId = typeof req.body?.channelId === 'string' ? req.body.channelId : ''
  const selectedChannel = verifiedSetup.channels.find((channel) => channel.id === selectedChannelId)
  if (!selectedChannel) return res.status(400).json({ error: 'Select a channel returned for the connected Google account.' })
  if (setupBusy) return res.status(409).json({ error: 'Setup is already being saved.' })

  setupBusy = true
  try {
    const config: SetupConfig = {
      completed: true,
      channelId: selectedChannel.id,
      channelName: selectedChannel.name,
      channelUrl: `https://www.youtube.com/channel/${selectedChannel.id}`,
      channelThumbnail: selectedChannel.thumbnail,
      verifiedEmail: verifiedSetup.email,
      googleSubject: verifiedSetup.subject,
      createdAt: new Date().toISOString(),
    }
    await fs.mkdir(appDataDir, { recursive: true })
    const tempFile = `${setupFile}.${randomBytes(6).toString('hex')}.tmp`
    await fs.writeFile(tempFile, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await fs.rename(tempFile, setupFile)
    setupConfig = config
    loggedOut = false
    invalidSavedSetup = false
    channelId = config.channelId
    verifiedSetup = null
    verifiedPurpose = null
    oauthAttempt = null
    res.json({ ok: true, channelName: config.channelName })
  } catch (error) {
    res.status(500).json({ error: setupErrorMessage(error) })
  } finally {
    setupBusy = false
  }
})

app.post('/api/setup/logout', (_req, res) => {
  if (!setupConfig?.completed) return res.status(409).json({ error: 'This user profile is not configured.' })
  void fs.mkdir(appDataDir, { recursive: true }).then(() => fs.writeFile(logoutFile, JSON.stringify({ loggedOut: true }), { encoding: 'utf8', mode: 0o600 })).then(() => {
    loggedOut = true
    oauthAttempt = null
    verifiedSetup = null
    verifiedPurpose = null
    setupError = ''
    res.setHeader('Cache-Control', 'no-store')
    res.json({ ok: true })
  }).catch((error) => res.status(500).json({ error: setupErrorMessage(error) }))
})

app.post('/api/setup/login', async (req, res) => {
  if (!setupConfig?.completed || !loggedOut) return res.status(409).json({ error: 'This profile is not waiting for Google sign-in.' })
  if (invalidSavedSetup) return res.status(409).json({ error: 'The saved setup is invalid and was preserved.' })
  if (!verifiedSetup || verifiedSetup.expiresAt <= Date.now() || verifiedPurpose !== 'login') return res.status(403).json({ error: 'Connect and verify your Google account before continuing.' })
  const selectedChannelId = typeof req.body?.channelId === 'string' ? req.body.channelId : ''
  const selectedChannel = verifiedSetup.channels.find((channel) => channel.id === selectedChannelId)
  if (!selectedChannel) return res.status(400).json({ error: 'Select a channel returned for the connected Google account.' })
  if (setupBusy) return res.status(409).json({ error: 'Sign-in is already being saved.' })

  setupBusy = true
  try {
    const config: SetupConfig = {
      ...setupConfig,
      channelId: selectedChannel.id,
      channelName: selectedChannel.name,
      channelUrl: `https://www.youtube.com/channel/${selectedChannel.id}`,
      channelThumbnail: selectedChannel.thumbnail,
      verifiedEmail: verifiedSetup.email,
      googleSubject: verifiedSetup.subject,
    }
    const tempFile = `${setupFile}.${randomBytes(6).toString('hex')}.tmp`
    await fs.writeFile(tempFile, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await fs.rename(tempFile, setupFile)
    await fs.unlink(logoutFile).catch((error) => {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error
    })
    setupConfig = config
    channelId = config.channelId
    loggedOut = false
    verifiedSetup = null
    verifiedPurpose = null
    oauthAttempt = null
    setupError = ''
    res.json({ ok: true, channelName: config.channelName, verifiedEmail: config.verifiedEmail })
  } catch (error) {
    res.status(500).json({ error: setupErrorMessage(error) })
  } finally {
    setupBusy = false
  }
})

app.post('/api/setup/reset', async (req, res) => {
  if (!setupConfig) return res.status(409).json({ error: 'This user profile is not configured.' })
  if (setupBusy) return res.status(409).json({ error: 'A setup change is already in progress.' })
  if (typeof req.body?.confirmation !== 'string' || req.body.confirmation !== 'RESET') {
    return res.status(400).json({ error: 'Type RESET to confirm clearing the saved channel setup.' })
  }
  setupBusy = true
  try {
    if (setupConfig.passwordHash && setupConfig.passwordSalt) {
      const password = typeof req.body?.password === 'string' ? req.body.password : ''
      const candidate = Buffer.from(await scrypt(password, setupConfig.passwordSalt, 64, { N: 16_384, r: 8, p: 1 }))
      const savedHash = Buffer.from(setupConfig.passwordHash, 'base64')
      if (candidate.length !== savedHash.length || !timingSafeEqual(candidate, savedHash)) {
        return res.status(401).json({ error: 'The password is incorrect.' })
      }
    } else {
      if (!verifiedSetup || verifiedSetup.expiresAt <= Date.now() || verifiedPurpose !== 'reset'
        || verifiedSetup.subject !== setupConfig.googleSubject
        || !verifiedSetup.channels.some((channel) => channel.id === setupConfig!.channelId)) {
        return res.status(403).json({ error: 'Reconnect the Google account that owns this channel before resetting setup.' })
      }
    }
    await fs.unlink(setupFile)
    setupConfig = null
    invalidSavedSetup = false
    channelId = defaultChannelId
    verifiedSetup = null
    verifiedPurpose = null
    oauthAttempt = null
    res.json({ ok: true })
  } catch (error) {
    res.status(500).json({ error: setupErrorMessage(error) })
  } finally {
    setupBusy = false
  }
})

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

// Serve channel avatars from this origin so browser cross-origin response blocking
// does not hide an otherwise valid YouTube thumbnail.
app.get('/api/channel-thumbnail', async (req, res) => {
  const rawUrl = req.query.url
  if (typeof rawUrl !== 'string') {
    res.status(400).end()
    return
  }
  let imageUrl: URL
  try {
    imageUrl = new URL(rawUrl)
  } catch {
    res.status(400).end()
    return
  }
  if (imageUrl.protocol !== 'https:' || !['yt3.ggpht.com', 'yt3.googleusercontent.com'].includes(imageUrl.hostname)) {
    res.status(400).end()
    return
  }
  try {
    const image = await fetch(imageUrl, { headers: { Accept: 'image/avif,image/webp,image/*,*/*;q=0.8' } })
    const contentType = image.headers.get('content-type') || ''
    if (!image.ok || !contentType.startsWith('image/')) {
      res.status(502).end()
      return
    }
    res.setHeader('Content-Type', contentType)
    res.setHeader('Cache-Control', 'public, max-age=3600')
    res.send(Buffer.from(await image.arrayBuffer()))
  } catch {
    res.status(502).end()
  }
})

app.get('/api/channel', async (_req, res) => {
  if (loggedOut) {
    res.status(401).json({ error: 'Sign in with Google to continue to the dashboard.' })
    return
  }
  if (!channelId) {
    res.status(409).json({ error: 'Complete the one-time channel setup before loading analytics.' })
    return
  }
  if (!apiKey) {
    const envPath = process.env.APP_CONFIG_DIR ? path.join(process.env.APP_CONFIG_DIR, '.env') : '.env'
    res.status(503).json({ error: `YouTube API is not configured. Add YOUTUBE_API_KEY to ${envPath}; see README.md for setup.` })
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

const clientDist = path.resolve(process.env.CLIENT_DIST_DIR || path.join(process.cwd(), 'dist'))
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(clientDist))
  app.get('*', (_req, res) => res.sendFile(path.join(clientDist, 'index.html')))
}

void readSetup().then((saved) => {
  setupConfig = saved
  channelId = saved?.channelId || defaultChannelId
  return readLogoutState()
}).then((isLoggedOut) => {
  loggedOut = isLoggedOut
  server = app.listen(port, host, () => {
    const address = server?.address()
    const listeningPort = address && typeof address === 'object' ? address.port : port
    console.log(`YouTube analytics server listening on http://${host}:${listeningPort}`)
    if (process.send) process.send({ type: 'server-ready', port: listeningPort })
  })
}).catch((error) => {
  console.error('Unable to read the saved MyYoutubeRecord setup:', error)
  process.exitCode = 1
})

process.on('message', (message: unknown) => {
  if (message && typeof message === 'object' && 'type' in message && message.type === 'shutdown') {
    if (server) server.close(() => process.exit(0))
    else process.exit(0)
  }
})
