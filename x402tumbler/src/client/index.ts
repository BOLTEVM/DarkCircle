/**
 * DarkCircle Protocol: Client Subsystem & Payment Interceptor Entrypoint
 * File: src/client/index.ts
 */

export * from "../proxy/index.ts";
export { OutboundPaymentInterceptor as PaymentInterceptor } from "../proxy/interceptor.ts";
