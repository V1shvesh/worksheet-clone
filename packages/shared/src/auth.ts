import { z } from "zod";

export const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(200),
});
export type SignupInput = z.infer<typeof signupSchema>;

export const loginSchema = signupSchema;
export type LoginInput = z.infer<typeof loginSchema>;

export const authUserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
});
export type AuthUser = z.infer<typeof authUserSchema>;
