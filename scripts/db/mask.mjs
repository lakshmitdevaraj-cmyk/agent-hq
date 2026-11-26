/** Every email address in a text, as first letter + *** + domain. */
export const maskEmails = (text) => String(text ?? "").replace(/([A-Za-z0-9._%+'=-]+)@(?=[A-Za-z0-9-]+\.)/g, (_, local) => `${local[0]}***@`);
