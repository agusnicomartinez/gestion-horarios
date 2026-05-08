import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'
import { format } from 'date-fns'
import { es } from 'date-fns/locale'
import type { Category, Employee, ScheduleEntry, Shift } from '../types/database'
import { eachDayInMonth, fromISO, toISO } from './dates'

interface PdfInput {
  monthISO: string
  departmentName: string
  employees: Employee[]
  categories: Category[]
  entries: ScheduleEntry[]
}

const SHIFT_LABEL: Record<Shift, string> = {
  off: 'L',
  morning: 'M',
  afternoon: 'T',
  night: 'N',
  partido: 'P',
  vacation: 'V',
  holiday: 'F',
  personal: 'DP',
  sick: 'B',
}

// RGB triples used as cell fills.
const SHIFT_COLOR: Record<Shift, [number, number, number]> = {
  off: [243, 244, 246],
  morning: [254, 243, 199],
  afternoon: [219, 234, 254],
  night: [203, 213, 225],
  partido: [254, 230, 191],
  vacation: [187, 247, 208],
  holiday: [251, 207, 232],
  personal: [221, 214, 254],
  sick: [254, 202, 202],
}

const SHIFT_TEXT_COLOR: Record<Shift, [number, number, number]> = {
  off: [107, 114, 128],
  morning: [146, 64, 14],
  afternoon: [30, 64, 175],
  night: [30, 41, 59],
  partido: [180, 83, 9],
  vacation: [22, 163, 74],
  holiday: [190, 24, 93],
  personal: [124, 58, 237],
  sick: [220, 38, 38],
}

export interface PdfResult {
  blob: Blob
  filename: string
}

export function buildSchedulePdf(input: PdfInput): PdfResult {
  const monthDate = fromISO(input.monthISO)
  const days = eachDayInMonth(monthDate)
  const monthLabel = format(monthDate, 'MMMM yyyy', { locale: es })

  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(14)
  doc.text(`Cronograma — ${input.departmentName}`, 10, 12)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.text(monthLabel.charAt(0).toUpperCase() + monthLabel.slice(1), 10, 18)

  const sortedEmployees = [...input.employees].sort((a, b) => {
    const ca = input.categories.find((c) => c.id === a.category_id)?.name ?? ''
    const cb = input.categories.find((c) => c.id === b.category_id)?.name ?? ''
    if (ca !== cb) return ca.localeCompare(cb)
    return a.full_name.localeCompare(b.full_name)
  })

  const entryByKey = new Map<string, Shift>()
  for (const e of input.entries) entryByKey.set(`${e.employee_id}|${e.date}`, e.shift)

  const head = [
    [
      'Empleado',
      ...days.map((d) => {
        const dow = ['D', 'L', 'M', 'X', 'J', 'V', 'S'][d.getDay()]
        return `${format(d, 'd')}\n${dow}`
      }),
    ],
  ]

  const body: string[][] = sortedEmployees.map((e) => {
    const cat = input.categories.find((c) => c.id === e.category_id)
    const name = cat ? `${e.full_name}\n${cat.name}` : e.full_name
    const cells = days.map((d) => {
      const shift = entryByKey.get(`${e.id}|${toISO(d)}`) ?? 'off'
      return SHIFT_LABEL[shift]
    })
    return [name, ...cells]
  })

  // Track shift per cell so we can colour individually in didParseCell.
  const shiftMatrix: Shift[][] = sortedEmployees.map((e) =>
    days.map((d) => entryByKey.get(`${e.id}|${toISO(d)}`) ?? 'off'),
  )

  autoTable(doc, {
    head,
    body,
    startY: 22,
    theme: 'grid',
    styles: { fontSize: 7, cellPadding: 1, halign: 'center', valign: 'middle' },
    headStyles: { fillColor: [55, 65, 81], textColor: 255, fontSize: 7 },
    columnStyles: { 0: { halign: 'left', fontStyle: 'bold', cellWidth: 35 } },
    didParseCell: (data) => {
      if (data.section !== 'body') return
      if (data.column.index === 0) return
      const row = data.row.index
      const col = data.column.index - 1
      const shift = shiftMatrix[row]?.[col]
      if (!shift) return
      data.cell.styles.fillColor = SHIFT_COLOR[shift]
      data.cell.styles.textColor = SHIFT_TEXT_COLOR[shift]
      if (shift !== 'off') data.cell.styles.fontStyle = 'bold'
    },
  })

  // Legend at bottom.
  const finalY = (doc as unknown as { lastAutoTable: { finalY: number } })
    .lastAutoTable.finalY + 6
  doc.setFontSize(8)
  doc.text(
    'M = Mañana · T = Tarde · N = Noche · P = Partido · V = Vacaciones · F = Festivo · DP = Día personal · B = Baja médica · L = Libre',
    10,
    finalY,
  )

  const filename = `cronograma-${input.departmentName.toLowerCase().replace(/\s+/g, '-')}-${input.monthISO.slice(0, 7)}.pdf`
  const blob = doc.output('blob')
  return { blob, filename }
}

export function downloadPdf(pdf: PdfResult): void {
  const url = URL.createObjectURL(pdf.blob)
  const a = document.createElement('a')
  a.href = url
  a.download = pdf.filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export async function sharePdf(pdf: PdfResult, fallbackText: string): Promise<'shared' | 'downloaded' | 'copied'> {
  const file = new File([pdf.blob], pdf.filename, { type: 'application/pdf' })
  const nav = navigator as Navigator & {
    canShare?: (data: { files?: File[] }) => boolean
    share?: (data: { files?: File[]; title?: string; text?: string }) => Promise<void>
  }
  if (nav.canShare?.({ files: [file] }) && nav.share) {
    try {
      await nav.share({
        files: [file],
        title: 'Cronograma',
        text: fallbackText,
      })
      return 'shared'
    } catch (err) {
      // User cancelled — fall through to download
      if ((err as Error).name === 'AbortError') return 'shared'
    }
  }
  // Desktop / unsupported: download as fallback.
  downloadPdf(pdf)
  return 'downloaded'
}
