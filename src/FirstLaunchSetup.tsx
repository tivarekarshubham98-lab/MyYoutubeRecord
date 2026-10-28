import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Check, ExternalLink, ShieldCheck, Youtube } from 'lucide-react'
import './setup.css'

type Props = { onComplete: (channelName: string, verifiedEmail: string) => void; initialNotice?: string; mode?: 'setup' | 'login' }
type AccessibleChannel = { id: string; name: string; thumbnail: string | null }
type VerifiedAccount = { email: string; channels: AccessibleChannel[] }

async function apiError(response: Response): Promise<string> {
  const result = await response.json().catch(() => ({})) as { error?: string }
  return result.error || 'Setup could not be completed. Please try again.'
}

export default function FirstLaunchSetup({ onComplete, initialNotice, mode = 'setup' }: Props) {
  const [verified, setVerified] = useState<VerifiedAccount | null>(null)
  const [selectedChannelId, setSelectedChannelId] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [watching, setWatching] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!watching) return
    let active = true
    const check = async () => {
      try {
        const response = await fetch('/api/setup/google/status', { cache: 'no-store' })
        const state = await response.json() as { status: string; email?: string; channels?: AccessibleChannel[]; error?: string }
        if (!active) return
        if (state.status === 'verified' && state.email && state.channels?.length) {
          setVerified({ email: state.email, channels: state.channels })
          setSelectedChannelId(state.channels[0].id)
          setWatching(false)
          setError('')
        } else if (state.status === 'error') {
          setWatching(false)
          setError(state.error || 'Google verification failed. Please try again.')
        }
      } catch {
        if (active) setError('Waiting for the local setup service. Please keep MyYoutubeRecord open.')
      }
    }
    void check()
    const timer = window.setInterval(() => void check(), 1200)
    return () => { active = false; window.clearInterval(timer) }
  }, [watching])

  const connectGoogle = async () => {
    setError('')
    setConnecting(true)
    try {
      const response = await fetch('/api/setup/google/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mode === 'login' ? { purpose: 'login' } : {}),
      })
      if (!response.ok) throw new Error(await apiError(response))
      const result = await response.json() as { authorizationUrl: string }
      setWatching(true)
      window.open(result.authorizationUrl, '_blank', 'noopener,noreferrer')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Google sign-in could not be started.')
    } finally {
      setConnecting(false)
    }
  }

  const saveSetup = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!verified || !selectedChannelId) return
    setError('')
    setSaving(true)
    try {
      const response = await fetch(mode === 'login' ? '/api/setup/login' : '/api/setup/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId: selectedChannelId }),
      })
      if (!response.ok) throw new Error(await apiError(response))
      const result = await response.json() as { channelName: string }
      onComplete(result.channelName, verified.email)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Setup could not be saved.')
    } finally {
      setSaving(false)
    }
  }

  const selectedChannel = verified?.channels.find((channel) => channel.id === selectedChannelId)

  return <main className="first-setup-page">
    <div className="first-setup-brand"><span className="brand-mark"><Youtube size={17} fill="currentColor" /></span><span>MyYoutubeRecord</span></div>
    <section className="first-setup-card">
      <div className="setup-eyebrow">{mode === 'login' ? 'GOOGLE SIGN IN' : 'ONE-TIME SETUP'}</div>
      <h1>{verified ? 'Choose your channel' : mode === 'login' ? 'Sign in to MyYoutubeRecord' : 'Connect your Google account'}</h1>
      <p className="setup-intro">{verified ? 'These YouTube channels are accessible to your verified Google account.' : mode === 'login' ? 'Sign in again with Google to fetch channels available to your account.' : 'Sign in with Google to find the YouTube channels available to your account.'}</p>
      {initialNotice && <div className="setup-error" role="alert">{initialNotice}</div>}

      <form onSubmit={saveSetup}>
        {!verified ? <>
          <button className="google-connect-button" type="button" onClick={() => void connectGoogle()} disabled={connecting || watching}>
            <span className="google-g">G</span>{connecting ? 'Opening Google sign-in…' : watching ? 'Waiting for Google verification…' : mode === 'login' ? 'Sign in with Google' : 'Connect Google Account'}<ExternalLink size={15} />
          </button>
          {error && <div className="setup-error" role="alert">{error}</div>}
        </> : <>
          <div className="verified-account"><span className="verified-check"><Check size={15} /></span><div><strong>{verified.email}</strong><small><ShieldCheck size={13} /> Google account verified</small></div></div>
          <div className="accessible-channels" role="radiogroup" aria-label="Accessible YouTube channels">
            {verified.channels.map((channel) => <label className={`accessible-channel${selectedChannelId === channel.id ? ' selected' : ''}`} key={channel.id}>
              <input type="radio" name="channel" value={channel.id} checked={selectedChannelId === channel.id} onChange={() => setSelectedChannelId(channel.id)} />
              <span className="accessible-channel-avatar">{channel.thumbnail ? <img src={`/api/channel-thumbnail?url=${encodeURIComponent(channel.thumbnail)}`} alt="" /> : <Youtube size={19} />}</span>
              <span className="accessible-channel-name">{channel.name}</span>
              <span className="accessible-channel-check"><Check size={14} /></span>
            </label>)}
          </div>

          {error && <div className="setup-error" role="alert">{error}</div>}
          <button className="setup-save-button" type="submit" disabled={!selectedChannel || saving}>
            {saving ? 'Opening dashboard…' : 'Go to Dashboard'}
          </button>
        </>}
      </form>
      <p className="setup-privacy-note">Google tokens are used only to verify channel access and are not stored. Your verified channel selection is saved on this computer.</p>
    </section>
    <span className="setup-footer">MADE FOR CREATORS</span>
  </main>
}
