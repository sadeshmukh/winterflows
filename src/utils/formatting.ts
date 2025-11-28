export function truncateText(text: string, maxLength: number) {
  if (text.length <= maxLength) return text
  return text.substring(0, maxLength - 1) + '…'
}

export function generateRandomId() {
  return Math.random().toString(36).substring(2, 11)
}
