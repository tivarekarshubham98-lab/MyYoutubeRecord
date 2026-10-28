import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { Download, ExternalLink, Eye, Heart, MessageCircle, Play, RefreshCw, Search, Video as VideoIcon, Youtube } from 'lucide-react'
import FirstLaunchSetup from './FirstLaunchSetup'
import type { DashboardData, Video } from './types'

const number = new Intl.NumberFormat('en-US')
const date = (value: string) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(value))
const time = (value: string) => new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(new Date(value))

type SetupStatus = { configured: boolean; loggedOut?: boolean; channelName?: string; verifiedEmail?: string; issue?: string; requiresPasswordForReset?: boolean }

export default function App() {
  const [setup, setSetup] = useState<SetupStatus | null>(null)
  const [setupError, setSetupError] = useState('')

  const loadSetup = useCallback(async () => {
    setSetupError('')
    try {
      const response = await fetch('/api/setup/status', { cache: 'no-store' })
      if (!response.ok) throw new Error('The local setup service is unavailable.')
      setSetup(await response.json() as SetupStatus)
    } catch (reason) {
      setSetupError(reason instanceof Error ? reason.message : 'The local setup service is unavailable.')
    }
  }, [])

  useEffect(() => { void loadSetup() }, [loadSetup])

  if (!setup) return <main className="first-setup-page"><div className="first-setup-brand"><span className="brand-mark"><Youtube size={17} fill="currentColor" /></span><span>MyYoutubeRecord</span></div><section className="first-setup-card setup-status-card"><div className="setup-eyebrow">MY YOUTUBE RECORD</div><h1>{setupError ? 'Can’t connect yet' : 'Starting your workspace'}</h1><p className="setup-intro">{setupError || 'Checking your one-time setup status…'}</p>{setupError && <button className="setup-save-button" onClick={() => void loadSetup()}>Try again</button>}</section></main>
  if (!setup.configured) return <FirstLaunchSetup mode={setup.loggedOut ? 'login' : 'setup'} initialNotice={setup.issue} onComplete={(channelName, verifiedEmail) => setSetup((previous) => ({ ...previous, configured: true, loggedOut: false, channelName, verifiedEmail }))} />
  return <Dashboard requiresPasswordForReset={setup.requiresPasswordForReset !== false} onLogout={() => setSetup((previous) => previous ? { ...previous, configured: false, loggedOut: true } : previous)} onReset={() => setSetup({ configured: false })} />
}

function Dashboard({ onReset, onLogout, requiresPasswordForReset }: { onReset: () => void; onLogout: () => void; requiresPasswordForReset: boolean }) {
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [showResetDialog, setShowResetDialog] = useState(false)
  const [resetPassword, setResetPassword] = useState('')
  const [resetConfirmation, setResetConfirmation] = useState('')
  const [resetError, setResetError] = useState('')
  const [resetting, setResetting] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)
  const [logoutError, setLogoutError] = useState('')
  const [resetGoogleVerified, setResetGoogleVerified] = useState(false)
  const [resetGoogleBusy, setResetGoogleBusy] = useState(false)

  const connectGoogleForReset = async () => {
    setResetError('')
    setResetGoogleBusy(true)
    try {
      const response = await fetch('/api/setup/google/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ purpose: 'reset' }) })
      const result = await response.json() as { authorizationUrl?: string; error?: string }
      if (!response.ok || !result.authorizationUrl) throw new Error(result.error || 'Google sign-in could not be started.')
      window.open(result.authorizationUrl, '_blank', 'noopener,noreferrer')
      const deadline = Date.now() + 10 * 60_000
      while (Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 1200))
        const statusResponse = await fetch('/api/setup/google/status', { cache: 'no-store' })
        const state = await statusResponse.json() as { status: string; error?: string }
        if (state.status === 'verified') { setResetGoogleVerified(true); return }
        if (state.status === 'error') throw new Error(state.error || 'Google verification failed.')
      }
      throw new Error('Google verification timed out. Please try again.')
    } catch (reason) {
      setResetError(reason instanceof Error ? reason.message : 'Google verification failed.')
    } finally { setResetGoogleBusy(false) }
  }

  const logout = async () => {
    setLogoutError('')
    setLoggingOut(true)
    try {
      const response = await fetch('/api/setup/logout', { method: 'POST' })
      const result = await response.json() as { error?: string }
      if (!response.ok) throw new Error(result.error || 'Logout could not be completed.')
      onLogout()
    } catch (reason) {
      setLogoutError(reason instanceof Error ? reason.message : 'Logout could not be completed. Please try again.')
    } finally { setLoggingOut(false) }
  }

  const resetSetup = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setResetError('')
    setResetting(true)
    try {
      const response = await fetch('/api/setup/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...(requiresPasswordForReset ? { password: resetPassword } : {}), confirmation: resetConfirmation }),
      })
      const result = await response.json() as { error?: string }
      if (!response.ok) throw new Error(result.error || 'The saved setup could not be reset.')
      onReset()
    } catch (reason) {
      setResetError(reason instanceof Error ? reason.message : 'The saved setup could not be reset.')
    } finally {
      setResetting(false)
    }
  }

  const load = useCallback(async (refresh = false) => {
    refresh ? setRefreshing(true) : setLoading(true)
    setError('')
    try {
      const response = await fetch('/api/channel')
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Unable to load channel data.')
      setData(result as DashboardData)
    } catch (reason) {
      if (reason instanceof TypeError && reason.message === 'Failed to fetch') {
        setError('Cannot reach the dashboard backend. Start the app with “npm run dev” from the project folder, then try again.')
      } else {
        setError(reason instanceof Error ? reason.message : 'Unable to load channel data.')
      }
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const videos = useMemo(() => (data?.videos ?? []).filter((video) => video.title.toLowerCase().includes(query.toLowerCase())), [data, query])
  const totals = useMemo(() => (data?.videos ?? []).reduce((sum, item) => ({
    views: sum.views + (item.views ?? 0), likes: sum.likes + (item.likes ?? 0), comments: sum.comments + (item.comments ?? 0),
  }), { views: 0, likes: 0, comments: 0 }), [data])

  const exportExcel = async () => {
    if (!data) return
    setExporting(true)
    try {
      const { default: ExcelJS } = await import('exceljs')
      const workbook = new ExcelJS.Workbook()
      workbook.creator = 'Channel analytics'
      workbook.created = new Date()
      const sheet = workbook.addWorksheet('Videos', { views: [{ state: 'frozen', ySplit: 1 }] })
      sheet.columns = [
        { header: 'Video title', key: 'title', width: 52 }, { header: 'Published date', key: 'publishedAt', width: 18 },
        { header: 'Views', key: 'views', width: 16 }, { header: 'Likes', key: 'likes', width: 14 },
        { header: 'Comments', key: 'comments', width: 16 }, { header: 'Visibility', key: 'visibility', width: 16 },
        { header: 'Duration', key: 'duration', width: 14 }, { header: 'Last updated', key: 'lastUpdated', width: 23 },
      ]
      sheet.addRows(data.videos.map((video) => ({ ...video, publishedAt: new Date(video.publishedAt), views: video.views ?? 'N/A', likes: video.likes ?? 'N/A', comments: video.comments ?? 'N/A', duration: video.duration ?? 'N/A', lastUpdated: new Date(video.lastUpdated) })))
      sheet.getRow(1).height = 32
      sheet.getRow(1).eachCell((cell) => { cell.font = { name: 'Aptos', bold: true, color: { argb: 'FFFFFFFF' }, size: 11 }; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF252B2A' } }; cell.alignment = { vertical: 'middle' } })
      sheet.getColumn(2).numFmt = 'mmm d, yyyy'
      sheet.getColumn(8).numFmt = 'mmm d, yyyy h:mm AM/PM'
      sheet.autoFilter = 'A1:H1'
      const bytes = await workbook.xlsx.writeBuffer()
      const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = `${data.channel.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-videos.xlsx`
      link.click()
      URL.revokeObjectURL(link.href)
    } catch {
      setError('The Excel file could not be created. Please try again.')
    } finally { setExporting(false) }
  }

  const metrics = [
    { label: 'Total views', value: number.format(totals.views), icon: Eye, color: 'lime' },
    { label: 'Total likes', value: number.format(totals.likes), icon: Heart, color: 'rose' },
    { label: 'Comments', value: number.format(totals.comments), icon: MessageCircle, color: 'violet' },
    { label: 'Videos', value: number.format(data?.videos.length ?? 0), icon: Play, color: 'amber' },
  ]

  return <main className="app-shell">
    <header className="topbar"><a className="brand" href="#"><span className="brand-mark"><Youtube size={20} fill="currentColor" /></span><span>studio<span className="brand-dot">.</span></span></a><span className="topbar-label">CHANNEL OVERVIEW</span><div className="topbar-right"><span className="live-dot" /> LIVE DATA <button className="channel-reset-button" onClick={() => { setResetError(''); setResetPassword(''); setResetConfirmation(''); setResetGoogleVerified(false); setShowResetDialog(true) }}>Change channel</button><button className="logout-button" onClick={() => void logout()} disabled={loggingOut}>{loggingOut ? 'Logging out…' : 'Logout'}</button></div></header>
    {logoutError && <div className="inline-error">{logoutError}</div>}
    <section className="page-content">
      <div className="page-heading"><div><div className="eyebrow">YOUR CHANNEL <span> / </span> OVERVIEW</div><h1>Analytics at a glance<span className="title-period">.</span></h1><p className="subtitle">Everything happening on your channel, all in one place.</p></div><div className="heading-actions"><button className="button button-secondary" onClick={() => void exportExcel()} disabled={!data || exporting || loading}><Download size={16} strokeWidth={2} />{exporting ? 'Preparing…' : 'Export Excel'}</button><button className={`button button-dark ${refreshing ? 'is-refreshing' : ''}`} onClick={() => void load(true)} disabled={refreshing || loading}><RefreshCw size={15} className={refreshing ? 'spin' : ''} />{refreshing ? 'Refreshing' : 'Refresh data'}</button></div></div>

      {loading && !data ? <div className="loading-panel"><span className="loader" /><div><strong>Fetching your channel</strong><p>Gathering your videos and their latest stats…</p></div></div> : error && !data ? <div className="error-panel"><span className="error-icon">!</span><div><strong>We couldn’t load your channel</strong><p>{error}</p><button onClick={() => void load()}>Try again <span>→</span></button></div></div> : data ? <>
        {error && <div className="inline-error">{error}</div>}
        <section className="channel-card"><div className="channel-avatar">{data.channel.thumbnail ? <img src={`/api/channel-thumbnail?url=${encodeURIComponent(data.channel.thumbnail)}`} alt="" /> : <span>{data.channel.title.slice(0, 1)}</span>}<span className="avatar-youtube"><Youtube size={13} fill="currentColor" /></span></div><div className="channel-info"><div className="channel-name-row"><h2>{data.channel.title}</h2><a href={`https://www.youtube.com/channel/${data.channel.id}`} target="_blank" rel="noreferrer" aria-label="Open YouTube channel"><ExternalLink size={14} /></a></div><div className="channel-meta"><span>{data.channel.subscribers === null ? 'Hidden' : number.format(data.channel.subscribers)} subscribers</span><i /><span>{number.format(data.channel.videoCount)} published videos</span></div></div><div className="channel-updated"><span className="updated-label">LAST SYNCED</span><strong>{date(data.refreshedAt)} <span>·</span> {time(data.refreshedAt)}</strong></div></section>

        <section className="metrics-grid">{metrics.map(({ label, value, icon: Icon, color }, index) => <article className="metric-card" key={label} style={{ animationDelay: `${index * 60}ms` }}><div className={`metric-icon ${color}`}><Icon size={17} strokeWidth={1.9} /></div><div className="metric-copy"><span>{label}</span><strong>{value}</strong></div><span className="metric-index">0{index + 1}</span></article>)}</section>

        <section className="videos-section"><div className="section-heading"><div><div className="eyebrow">CONTENT LIBRARY</div><h2>All videos <span className="count-pill">{number.format(data.videos.length)}</span></h2><p>A complete list of videos published to your channel.</p></div><label className="search-box"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search videos" aria-label="Search videos" />{query && <button onClick={() => setQuery('')} aria-label="Clear search">×</button>}</label></div>
          <div className="table-wrap"><table><thead><tr><th className="title-column">VIDEO</th><th>PUBLISHED</th><th>VIEWS</th><th>LIKES</th><th>COMMENTS</th><th>VISIBILITY</th><th>DURATION</th><th>LAST UPDATED</th></tr></thead><tbody>{refreshing && <tr className="refresh-row"><td colSpan={8}><span className="loader small" /> Updating video stats…</td></tr>}{videos.map((video) => <VideoRow key={video.id} video={video} />)}</tbody></table>{videos.length === 0 && <div className="empty-state"><VideoIcon size={20} /><strong>{query ? 'No videos match your search' : 'No videos found'}</strong><span>{query ? 'Try another title or clear your search.' : 'Your public videos will appear here.'}</span></div>}</div>
          <div className="table-footer"><span>Showing <strong>{number.format(videos.length)}</strong> of <strong>{number.format(data.videos.length)}</strong> videos</span><span className="data-note"><span className="info-dot">i</span> Public video data · refreshed {time(data.refreshedAt)}</span></div>
        </section>
      </> : null}
      <footer className="footer"><span>MADE FOR CREATORS</span><span>YOUTUBE DATA API <i /> LIVE SYNC</span></footer>
    </section>
    {showResetDialog && <div className="reset-overlay"><section className="reset-dialog" role="dialog" aria-modal="true" aria-labelledby="reset-title"><div className="setup-eyebrow">CONFIRM CHANNEL RESET</div><h2 id="reset-title">Change saved channel</h2><p>This removes only the saved channel setup for this Windows profile. Your API key, exports, and other files stay in place. Google verification will be required again.</p><form onSubmit={(event) => void resetSetup(event)}>{requiresPasswordForReset ? <label className="setup-field"><span>Setup password</span><input type="password" autoComplete="current-password" required value={resetPassword} onChange={(event) => setResetPassword(event.target.value)} /></label> : <button type="button" className="google-connect-button" onClick={() => void connectGoogleForReset()} disabled={resetGoogleBusy || resetGoogleVerified}>{resetGoogleVerified ? 'Google account verified' : resetGoogleBusy ? 'Waiting for Google verification…' : 'Verify Google account to reset'}</button>}<label className="setup-field"><span>Type RESET to confirm</span><input autoComplete="off" required value={resetConfirmation} onChange={(event) => setResetConfirmation(event.target.value)} /></label>{resetError && <div className="setup-error" role="alert">{resetError}</div>}<div className="reset-actions"><button type="button" className="button button-secondary" onClick={() => setShowResetDialog(false)} disabled={resetting}>Cancel</button><button type="submit" className="button button-dark" disabled={resetting || resetConfirmation !== 'RESET' || (!requiresPasswordForReset && !resetGoogleVerified)}>{resetting ? 'Resetting…' : 'Reset setup'}</button></div></form></section></div>}
  </main>
}

function VideoRow({ video }: { video: Video }) {
  return <tr><td className="video-cell"><a className="video-thumb" href={video.url} target="_blank" rel="noreferrer">{video.thumbnail ? <img src={video.thumbnail} alt="" loading="lazy" /> : <span><Play size={15} fill="currentColor" /></span>}<span className="thumb-play"><Play size={12} fill="currentColor" /></span></a><a className="video-title" href={video.url} target="_blank" rel="noreferrer" title={video.title}>{video.title}</a></td><td className="date-cell">{date(video.publishedAt)}</td><td className="number-cell">{video.views === null ? <span className="na">N/A</span> : number.format(video.views)}</td><td className="number-cell">{video.likes === null ? <span className="na">N/A</span> : number.format(video.likes)}</td><td className="number-cell">{video.comments === null ? <span className="na">N/A</span> : number.format(video.comments)}</td><td><span className={`visibility ${video.visibility.toLowerCase()}`}><i />{video.visibility}</span></td><td className="duration-cell">{video.duration ?? 'N/A'}</td><td className="updated-cell">{date(video.lastUpdated)} · {time(video.lastUpdated)}</td></tr>
}
