// Mongoose models that match test/fixtures/config.ts exactly. A separate Mongoose instance, so
// the models don't clash with other tests' models.
import { Mongoose, Schema } from "mongoose";

const mongoose = new Mongoose();

export const User = mongoose.model(
  "User",
  new Schema({
    phone: String,
    name: String,
    interests: String,
    emailVerifiedAt: Date, // describes data, isn't personal itself
    createdAt: { type: Date, required: true },
  }),
  "users",
);

export const Order = mongoose.model("Order", new Schema({ user_id: { type: String, required: true }, address: String, total: Number }), "orders");

export const AnalyticsEvent = mongoose.model("AnalyticsEvent", new Schema({ user_id: String, device: String }), "analytics_events");

export const Product = mongoose.model("Product", new Schema({ name: String }), "products"); // name is in notPersonal
