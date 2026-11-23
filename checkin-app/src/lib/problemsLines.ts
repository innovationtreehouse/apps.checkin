/** The Problems line for a source whose read failed: the library's stuck items, the failed-email count, or the Shopify reader's runs. */
export const unreadLine = (library: string): string => {
    if (library === "email") return "Failed email sends could not be counted.";
    if (library === "Shopify reader") return "The Shopify reader's runs could not be read.";
    return `Could not read the stuck items in ${library}.`;
};
