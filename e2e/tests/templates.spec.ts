import type { Page } from "@playwright/test";
import { expect, test } from "./support/fixtures.js";
import { randomPassword, randomText, readLink, rowMenu } from "./support/flows.js";

// Templates live in the IndexedDB of the browser that keeps them, and never on the server. A
// templates link carries its export in the fragment, which the guard checks like a key.

/** Lays out a request asking for files and a note with one field, and saves it as a template. */
async function saveTemplate(page: Page, template: { name: string; title: string; field: string }) {
  await page.goto("/requests");
  await page.getByRole("tab", { name: /^Both/ }).click();
  await page.getByLabel("What do you need? (optional)").fill(template.title);
  await page.getByRole("button", { name: "Password", exact: true }).click();
  await page.getByPlaceholder("Field 1, for example Password").fill(template.field);
  await page.getByRole("button", { name: "Save as template" }).click();
  const dialog = page.getByRole("dialog", { name: "Save as template" });
  await dialog.getByLabel("Name").fill(template.name);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(`“${template.name}” saved as a template.`)).toBeVisible();
}

function templateRow(page: Page, name: string) {
  return page.getByRole("listitem").filter({ hasText: name });
}

test("a template saved from the form starts the next request", async ({
  page,
  openRecipient,
  guard,
}) => {
  const template = {
    name: randomText("Server access"),
    title: randomText("Access for"),
    field: randomText("Root password"),
  };
  guard.text(template.name, template.title, template.field);
  await saveTemplate(page, template);

  await page.goto("/settings?tab=templates");
  await templateRow(page, template.name).getByRole("link", { name: "Use" }).click();
  await expect(page.getByLabel("What do you need? (optional)")).toHaveValue(template.title);
  await page.getByRole("button", { name: "Create request" }).click();
  const uploadLink = await readLink(page, "Upload link");
  await guard.requestLinks(uploadLink, await readLink(page, "Your inbox link"));

  const sender = await openRecipient();
  await sender.goto(uploadLink);
  await expect(sender.getByText(template.title)).toBeVisible();
  await expect(sender.getByRole("textbox", { name: template.field, exact: true })).toBeVisible();
});

test("a sealed templates link moves a template to another browser", async ({
  page,
  openRecipient,
  guard,
}) => {
  const template = {
    name: randomText("Onboarding"),
    title: randomText("Welcome kit"),
    field: randomText("Laptop password"),
  };
  const password = randomPassword();
  guard.text(template.name, template.title, template.field, password);
  await saveTemplate(page, template);

  await page.goto("/settings?tab=templates");
  await rowMenu(templateRow(page, template.name), "Export");
  const exporting = page.getByRole("dialog", { name: "Export templates" });
  await exporting.getByRole("radio", { name: /^As a link/ }).click();
  await exporting.getByRole("switch", { name: "Encrypt with a password" }).click();
  await exporting.getByPlaceholder("Password for the export").fill(password);
  await exporting.getByRole("button", { name: "Export 1" }).click();
  const link = await exporting.getByLabel("Templates link").inputValue();
  guard.secretOf(link);

  const other = await openRecipient();
  await other.goto(link);
  const importing = other.getByRole("dialog", { name: "Import templates" });
  await importing.getByLabel("Password of the export").fill(`${password}-wrong`);
  await importing.getByRole("button", { name: "Open" }).click();
  await expect(importing.getByText("Wrong password.")).toBeVisible();
  await importing.getByLabel("Password of the export").fill(password);
  await importing.getByRole("button", { name: "Open" }).click();
  await importing.getByRole("button", { name: "Import 1" }).click();
  await expect(other.getByText("1 template imported.")).toBeVisible();
  await expect(templateRow(other, template.name)).toBeVisible();
});
