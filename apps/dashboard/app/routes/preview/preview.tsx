import { redirect } from 'react-router'

import type { Route } from './+types/preview'

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url)
  const tab = url.searchParams.get('tab') || 'tests'
  return redirect(`/strategy-builder?tab=${tab}`)
}

export default function PreviewRedirect() {
  return null
}
