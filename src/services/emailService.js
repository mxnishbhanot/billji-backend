import { env } from '../config/env.js';
import { createTransporter } from '../config/mailer.js';
import { ApiError } from '../utils/ApiError.js';
import { generateInvoicePdf } from './pdfService.js';

export const sendInvoiceEmail = async ({ invoice, business, to, pdfUrl }) => {
  const recipient = to || invoice.customerSnapshot.email;

  if (!recipient) {
    throw new ApiError(422, 'Customer email is required to send invoice');
  }

  const transporter = createTransporter();

  if (!transporter) {
    throw new ApiError(503, 'Email service is not configured');
  }

  const pdf = await generateInvoicePdf(invoice, business);

  await transporter.sendMail({
    from: env.smtp.from,
    to: recipient,
    subject: `Invoice ${invoice.invoiceNumber} from ${business?.businessName || 'QuickInvoice'}`,
    text: `Hello ${invoice.customerSnapshot.name}, your invoice is attached. You can also download it here: ${pdfUrl || invoice.pdfUrl}`,
    attachments: [
      {
        filename: `${invoice.invoiceNumber}.pdf`,
        content: pdf,
        contentType: 'application/pdf'
      }
    ]
  });

  invoice.emailedAt = new Date();
  await invoice.save();

  return { recipient };
};
