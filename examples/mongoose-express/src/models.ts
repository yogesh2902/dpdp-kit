import mongoose, { Schema } from "mongoose";

export const User = mongoose.model(
  "User",
  new Schema(
    {
      name: { type: String, required: true },
      phone: { type: String, required: true },
      email: { type: String, required: true, unique: true },
      city: String,
      interests: String,
    },
    { timestamps: true },
  ),
  "users",
);

/**
 * Invoices outlive the account: GST law makes you keep them for 8 years, so an order keeps the
 * customer's id as a plain string rather than a reference that would dangle or cascade.
 */
export const Order = mongoose.model(
  "Order",
  new Schema(
    {
      userId: { type: String, required: true, index: true },
      address: { type: String, required: true },
      total: { type: Number, required: true },
    },
    { timestamps: true },
  ),
  "orders",
);
