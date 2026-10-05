import { db } from "../db";
import crypto from "crypto";
import { recordAudit } from "./audit";
import type { ParsedOrder } from "./shopify-order-csv-parser";

export interface OrderImportSummary {
  imported: number;
  skipped: number;
  total: number;
}

export async function importShopifyOrders(
  orgId: string,
  userId: number,
  filename: string,
  buffer: Buffer,
  parsedOrders: Map<string, ParsedOrder>,
  correlationId?: string,
  username?: string,
): Promise<OrderImportSummary> {
  const fileHash = crypto.createHash("sha256").update(buffer).digest("hex");
  const totalOrders = parsedOrders.size;

  let rowCount = 0;
  for (const { lineItems } of parsedOrders.values()) rowCount += lineItems.length;

  return db.$transaction(async (tx) => {
    let imported = 0;
    let skipped = 0;

    const importFile = await tx.shopifyImportFile.create({
      data: {
        orgId,
        uploadedByUserId: userId,
        originalFilename: filename,
        fileHash,
        rowCount,
        newOrderCount: 0,
        skippedOrderCount: 0,
      },
    });

    for (const [purchaseId, { orderRow, lineItems }] of parsedOrders) {
      const existing = await tx.shopifyOrderBlob.findFirst({
        where: { orgId, purchaseId },
      });

      if (existing) {
        skipped++;
        continue;
      }

      const email = orderRow.email;
      let customerId: number;

      const existingCustomer = await tx.shopifyCustomer.findFirst({
        where: { orgId, email },
      });

      if (existingCustomer) {
        const nextBilling = {
          billingName: orderRow.billingName || existingCustomer.billingName,
          billingStreet: orderRow.billingStreet || existingCustomer.billingStreet,
          billingAddress1: orderRow.billingAddress1 || existingCustomer.billingAddress1,
          billingAddress2: orderRow.billingAddress2 || existingCustomer.billingAddress2,
          billingCompany: orderRow.billingCompany || existingCustomer.billingCompany,
          billingCity: orderRow.billingCity || existingCustomer.billingCity,
          billingZip: orderRow.billingZip || existingCustomer.billingZip,
          billingProvince: orderRow.billingProvince || existingCustomer.billingProvince,
          billingCountry: orderRow.billingCountry || existingCustomer.billingCountry,
          billingPhone: orderRow.billingPhone || existingCustomer.billingPhone,
          phone: orderRow.phone || existingCustomer.phone,
        };

        const changed = (Object.keys(nextBilling) as Array<keyof typeof nextBilling>)
          .some((k) => nextBilling[k] !== existingCustomer[k]);
        if (changed) {
          await recordAudit(tx, {
            orgId, actorUserId: userId, actorUsername: username, action: "customer.billing.updated",
            entityType: "customer", entityId: existingCustomer.id,
            before: {
              billingName: existingCustomer.billingName, billingStreet: existingCustomer.billingStreet,
              billingAddress1: existingCustomer.billingAddress1, billingAddress2: existingCustomer.billingAddress2,
              billingCompany: existingCustomer.billingCompany, billingCity: existingCustomer.billingCity,
              billingZip: existingCustomer.billingZip, billingProvince: existingCustomer.billingProvince,
              billingCountry: existingCustomer.billingCountry, billingPhone: existingCustomer.billingPhone,
              phone: existingCustomer.phone,
            },
            after: nextBilling,
            reason: `order_import:${purchaseId}`,
            correlationId,
          });
        }

        await tx.shopifyCustomer.update({
          where: { id: existingCustomer.id },
          data: nextBilling,
        });
        customerId = existingCustomer.id;
      } else {
        const newCustomer = await tx.shopifyCustomer.create({
          data: {
            orgId,
            email,
            billingName: orderRow.billingName || null,
            billingStreet: orderRow.billingStreet || null,
            billingAddress1: orderRow.billingAddress1 || null,
            billingAddress2: orderRow.billingAddress2 || null,
            billingCompany: orderRow.billingCompany || null,
            billingCity: orderRow.billingCity || null,
            billingZip: orderRow.billingZip || null,
            billingProvince: orderRow.billingProvince || null,
            billingCountry: orderRow.billingCountry || null,
            billingPhone: orderRow.billingPhone || null,
            phone: orderRow.phone || null,
          },
        });
        customerId = newCustomer.id;
      }

      const payload = {
        source: "Shopify" as const,
        order: {
          name: orderRow.name,
          email: orderRow.email,
          financialStatus: orderRow.financialStatus,
          paidAt: orderRow.paidAt,
          fulfillmentStatus: orderRow.fulfillmentStatus,
          fulfilledAt: orderRow.fulfilledAt,
          currency: orderRow.currency,
          subtotal: orderRow.subtotal,
          shipping: orderRow.shipping,
          taxes: orderRow.taxes,
          total: orderRow.total,
          discountCode: orderRow.discountCode,
          discountAmount: orderRow.discountAmount,
          createdAt: orderRow.createdAt,
          refundedAmount: orderRow.refundedAmount,
          cancelledAt: orderRow.cancelledAt,
          shopifyNumericId: orderRow.shopifyNumericId,
          billingName: orderRow.billingName,
          billingStreet: orderRow.billingStreet,
          billingAddress1: orderRow.billingAddress1,
          billingAddress2: orderRow.billingAddress2,
          billingCompany: orderRow.billingCompany,
          billingCity: orderRow.billingCity,
          billingZip: orderRow.billingZip,
          billingProvince: orderRow.billingProvince,
          billingCountry: orderRow.billingCountry,
          billingPhone: orderRow.billingPhone,
          phone: orderRow.phone,
        },
        lineItems: lineItems.map((li) => ({
          quantity: li.lineitemQuantity,
          name: li.lineitemName,
          price: li.lineitemPrice,
          compareAtPrice: li.lineitemCompareAtPrice,
          sku: li.lineitemSku,
          discount: li.lineitemDiscount,
          fulfillmentStatus: li.lineitemFulfillmentStatus,
        })),
      };

      await tx.shopifyOrderBlob.create({
        data: {
          orgId,
          purchaseId,
          paidAt: orderRow.paidAt || null,
          totalCents: orderRow.total,
          payload: JSON.stringify(payload),
          importFileId: importFile.id,
        },
      });

      const order = await tx.shopifyOrder.create({
        data: {
          orgId,
          purchaseId,
          shopifyNumericId: orderRow.shopifyNumericId || null,
          customerId,
          financialStatus: orderRow.financialStatus || null,
          paidAt: orderRow.paidAt || null,
          fulfillmentStatus: orderRow.fulfillmentStatus || null,
          fulfilledAt: orderRow.fulfilledAt || null,
          cancelledAt: orderRow.cancelledAt || null,
          createdAt: orderRow.createdAt || null,
          currency: orderRow.currency || null,
          subtotalCents: orderRow.subtotal,
          shippingCents: orderRow.shipping,
          taxesCents: orderRow.taxes,
          totalCents: orderRow.total,
          discountCode: orderRow.discountCode || null,
          discountAmountCents: orderRow.discountAmount,
          refundedAmountCents: orderRow.refundedAmount,
        },
      });

      for (const li of lineItems) {
        await tx.shopifyOrderLineItem.create({
          data: {
            orderId: order.id,
            orgId,
            quantity: li.lineitemQuantity,
            name: li.lineitemName,
            priceCents: li.lineitemPrice,
            compareAtPriceCents: li.lineitemCompareAtPrice,
            sku: li.lineitemSku || null,
            discountCents: li.lineitemDiscount,
            fulfillmentStatus: li.lineitemFulfillmentStatus || null,
          },
        });
      }

      imported++;
    }

    await tx.shopifyImportFile.update({
      where: { id: importFile.id },
      data: { newOrderCount: imported, skippedOrderCount: skipped },
    });

    return { imported, skipped, total: totalOrders };
  });
}
