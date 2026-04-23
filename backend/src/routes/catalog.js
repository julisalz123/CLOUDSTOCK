const router = require('express').Router();
const PDFDocument = require('pdfkit');
const auth = require('../middleware/auth');
const pool = require('../models/db');
const tnService = require('../services/tiendanube');

router.get('/catalog', auth, async (req, res) => {
  try {
    const { category, storeName = 'Mi Catálogo' } = req.query;

    const { rows: storeRows } = await pool.query(
      `SELECT * FROM stores WHERE user_id = $1 AND platform = 'tiendanube'`,
      [req.userId]
    );
    if (!storeRows[0]) return res.status(400).json({ error: 'Tiendanube no conectada' });

    const products = await tnService.getAllProducts(storeRows[0].store_id, storeRows[0].access_token);
    const parsed = tnService.parseProducts(products);

    // Filtra por categoría si se especificó
    const filtered = category
      ? parsed.filter(p => p.productName.toLowerCase().includes(category.toLowerCase()))
      : parsed;

    // Genera el PDF
    const doc = new PDFDocument({ margin: 40, size: 'A4' });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="catalogo-${Date.now()}.pdf"`);
    doc.pipe(res);

    // Portada
    doc.rect(0, 0, doc.page.width, 120).fill('#1a1a2e');
    doc.fillColor('white')
       .fontSize(28).font('Helvetica-Bold')
       .text(storeName, 40, 35, { align: 'center' });
    doc.fontSize(14).font('Helvetica')
       .text('Catálogo de Productos', 40, 75, { align: 'center' });
    doc.fillColor('black');

    doc.moveDown(2);

    if (filtered.length === 0) {
      doc.fontSize(14).text('No se encontraron productos con ese filtro.', { align: 'center' });
      doc.end();
      return;
    }

    // Genera tabla de productos
    const tableTop = 150;
    const rowHeight = 28;
    const colWidths = [180, 80, 80, 80, 100];
    const cols = [40, 220, 300, 380, 460];
    const headers = ['Producto', 'SKU', 'Stock', 'Precio', 'Variante'];

    // Encabezado de tabla
    doc.rect(40, tableTop, 515, rowHeight).fill('#f0f0f5');
    doc.fillColor('#1a1a2e').fontSize(10).font('Helvetica-Bold');
    headers.forEach((h, i) => {
      doc.text(h, cols[i], tableTop + 9, { width: colWidths[i] });
    });

    doc.fillColor('black').font('Helvetica').fontSize(9);
    let y = tableTop + rowHeight;

    for (const [idx, product] of filtered.entries()) {
      if (y > doc.page.height - 80) {
        doc.addPage();
        y = 60;
        // Repite encabezado en nueva página
        doc.rect(40, y - rowHeight, 515, rowHeight).fill('#f0f0f5');
        doc.fillColor('#1a1a2e').font('Helvetica-Bold').fontSize(10);
        headers.forEach((h, i) => doc.text(h, cols[i], y - rowHeight + 9, { width: colWidths[i] }));
        doc.fillColor('black').font('Helvetica').fontSize(9);
      }

      // Alterna color de filas
      if (idx % 2 === 0) {
        doc.rect(40, y, 515, rowHeight).fill('#fafafa');
      }
      doc.fillColor('#333');

      const variantLabel = product.values?.map(v => v.es || v.pt || Object.values(v)[0]).join(' / ') || '-';
      const stockText = product.stock === null ? 'Sin límite' : String(product.stock);
      const priceText = product.price ? `$${parseFloat(product.price).toLocaleString('es-AR')}` : '-';

      doc.text(product.productName?.substring(0, 28) || '-', cols[0], y + 9, { width: colWidths[0] });
      doc.text(product.sku || '-', cols[1], y + 9, { width: colWidths[1] });
      doc.text(stockText, cols[2], y + 9, { width: colWidths[2] });
      doc.text(priceText, cols[3], y + 9, { width: colWidths[3] });
      doc.text(variantLabel.substring(0, 15), cols[4], y + 9, { width: colWidths[4] });

      // Línea separadora
      doc.moveTo(40, y + rowHeight).lineTo(555, y + rowHeight)
         .stroke('#e0e0e0');

      y += rowHeight;
    }

    // Pie de página
    doc.moveDown(2);
    doc.fontSize(8).fillColor('#888')
       .text(`Generado por SyncStock · ${new Date().toLocaleDateString('es-AR')} · ${filtered.length} productos`, 
             40, doc.page.height - 40, { align: 'center' });

    doc.end();
  } catch (err) {
    console.error('Error generando PDF:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Error al generar el catálogo PDF' });
  }
});

module.exports = router;
