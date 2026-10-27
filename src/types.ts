export interface Channel {
  id: string
  title: string
  description: string
  thumbnail: string | null
  subscribers: number | null
  videoCount: number
  viewCount: number
}

export interface Video {
  id: string
  title: string
  publishedAt: string
  views: number | null
  likes: number | null
  comments: number | null
  visibility: 'Public' | 'Unlisted' | 'Private' | 'Unavailable'
  duration: string | null
  lastUpdated: string
  thumbnail: string | null
  url: string
}

export interface DashboardData {
  channel: Channel
  videos: Video[]
  refreshedAt: string
}
