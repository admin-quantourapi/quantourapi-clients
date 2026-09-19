export enum BotCommand {
  // --- CATEGORIES ---
  MARKET = 'market',
  PORTFOLIO = 'portfolio',
  SETTINGS = 'settings',
  HELP = 'help',

  // --- MARKET ---
  SCAN = 'scan',
  MARKET_SCAN = 'market_scan',
  MACRO = 'macro',

  // --- PORTFOLIO ---
  STATUS = 'status',
  BUY = 'buy',
  SELL = 'sell',
  EXIT = 'exit',
  OPTIMIZE = 'optimize',
  FREE_CASH = 'free_cash',
  WANT_BUY = 'want_buy',
  DEEP_PORTFOLIO = 'deep_portfolio',
  PNL = 'pnl',

  // --- TICKER ---
  RESEARCH = 'research',
  INFO = 'info',

  // --- SETTINGS ---
  LINK = 'link',
  START = 'start',
  API = 'api',
  CREDIT = 'credit',
  ME = 'me',
  NAME = 'name',
  BUDGET = 'budget',
  RISK = 'risk',
  MODE = 'mode',
  SILENT = 'silent',
  LANG = 'lang',
  GUIDE = 'guide',
}
