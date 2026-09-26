import type { Settings, Profile, SoundMix } from './types'

export const SUBJECTS = ['Mathematics', 'Computer Science', 'Physics', 'Economics', 'Databases', 'Literature']

export const DEFAULT_SETTINGS: Settings = {
  env: 'dark',
  theme: 'rainy',
  animation: 'full',
  masterVolume: 0.7,
  focusMin: 25,
  shortMin: 5,
  longMin: 15,
  longEvery: 4,
  dailyGoalMin: 120,
  autoStartNext: true,
  autoSound: true,
  notifyInApp: true,
  notifyBrowser: false,
  chime: true,
}

export const DEFAULT_PROFILE: Profile = { name: '', avatar: 3, favSubject: 'General' }

export const DEFAULT_MIX: SoundMix = {
  rain: { on: false, vol: 0.6 },
  fire: { on: false, vol: 0.5 },
  cafe: { on: false, vol: 0.4 },
  library: { on: false, vol: 0.5 },
  brown: { on: false, vol: 0.4 },
  lofi: { on: false, vol: 0.5 },
}

export const TICKER_LINES = [
  'Small steps, every day',
  'Rain on the window, notes on the desk',
  'One task at a time',
  'Take the break when the timer says so',
  'Drink some water',
  'Close the tabs you do not need',
]
