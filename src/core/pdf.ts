import { PDFDocument, StandardFonts } from "pdf-lib"

/** HU-4 P1: PDF de la evidencia con el mismo texto que aprobacion.txt (fechas fijas: PDF determinista). */
export async function pdfEvidencia(texto: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const fecha = new Date("2026-01-01T00:00:00Z")
  doc.setTitle("Evidencia de aprobación")
  doc.setCreationDate(fecha)
  doc.setModificationDate(fecha)
  const fuente = await doc.embedFont(StandardFonts.Helvetica)
  let pagina = doc.addPage([595, 842])
  let y = 800
  for (const linea of partir(texto, 90)) {
    if (y < 50) {
      pagina = doc.addPage([595, 842])
      y = 800
    }
    pagina.drawText(linea, { x: 50, y, size: 11, font: fuente })
    y -= 16
  }
  return doc.save()
}

function partir(texto: string, ancho: number): string[] {
  return texto.split("\n").flatMap((l) => {
    const salida: string[] = []
    let actual = ""
    for (const palabra of l.split(" ")) {
      if ((actual + " " + palabra).trim().length > ancho) {
        salida.push(actual)
        actual = palabra
      } else actual = (actual + " " + palabra).trim()
    }
    salida.push(actual)
    return salida
  })
}
