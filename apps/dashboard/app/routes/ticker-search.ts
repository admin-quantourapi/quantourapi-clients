import { fetchFromPublicApi } from 'app/utils/apiClient'

import type { Route } from './+types/ticker-search'



export async function action({ request }: Route.ActionArgs) {
  const formData = await request.formData()
  const intent = formData.get('intent')

  if (intent === 'search') {
    const query = formData.get('query')?.toString()
    if (!query || query.length < 2) return { searchResults: [] }
    try {
      const res = await fetchFromPublicApi(`/market/search?query=${query}`, request)
      return { searchResults: res?.data || [] }
    } catch {
      return { searchResults: [], error: 'Search failed' }
    }
  }

  // Unknown intents return a benign success so a stale client fetch can't
  // crash the panel.
  return { success: true }
}
