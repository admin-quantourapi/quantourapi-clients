import {
  index, route, type RouteConfig, 
} from '@react-router/dev/routes'

export default [

  index('routes/tickers/tickers.tsx'),

  route('tickers/:symbol', 'routes/ticker-detail/ticker-detail.tsx'),
  route('tickers/:symbol/macro-events', 'routes/ticker-detail/macro-events.tsx'),
  route('tickers/:symbol/connections', 'routes/ticker-detail/connections.tsx'),
  route('preview', 'routes/preview/preview.tsx'),

  route('signals', 'routes/signals/signals.tsx'),
  route('catalysts', 'routes/catalysts/catalysts.tsx'),
  route('emerging-leaders', 'routes/emerging-leaders.tsx'),
  route('second-derivative', 'routes/second-derivative.tsx'),
  route('macro-narratives', 'routes/macro-narratives/macro-narratives.tsx'),
  route('market-thesis', 'routes/market-thesis/market-thesis.tsx'),
  route('login', 'routes/login/login.tsx'),
  route('settings/api-keys', 'routes/settings/api-keys.tsx'),
  route('ticker-search', 'routes/ticker-search.ts'),
  route('strategy-builder', 'routes/strategy-builder/strategy-builder.tsx'),
  route('cohorts', 'routes/cohorts.tsx'),
  route('positions', 'routes/positions/positions.tsx'),
  route('api/*', 'routes/api.$.tsx'),
  route('public-api/*', 'routes/public-api.$.tsx'),
  route('debug-ast', 'routes/debug-ast.tsx', { id: 'debug-ast-route' }),
  route('debug-metrics', 'routes/debug-ast.tsx', { id: 'debug-metrics-route' }),
] satisfies RouteConfig
