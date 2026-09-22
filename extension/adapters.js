(function registerClearLeadAdapters(scope) {
  const definitions = [
    adapter("workday", [/(?:^|\.)myworkdayjobs\.com$/i], workdayFields(), ["[data-automation-id='applyFlowPage']", "[data-automation-id='applicationPage']"], { multiPage: true, resumeAttachment: "manual", applicationState: true }),
    adapter("greenhouse", [/(?:^|\.)greenhouse\.io$/i, /(?:^|\.)greenhouse\.com$/i], greenhouseFields(), ["#application_form", "form#application-form", "form[action*='applications']"], { multiPage: false, resumeAttachment: "manual", applicationState: true }),
    adapter("lever", [/(?:^|\.)lever\.co$/i], leverFields(), [".application-form", "form[action*='apply']"], { multiPage: false, resumeAttachment: "manual", applicationState: true }),
    adapter("ashby", [/(?:^|\.)ashbyhq\.com$/i], ashbyFields(), ["[data-testid='application-form']", "form"], { multiPage: false, resumeAttachment: "manual", applicationState: true }),
    adapter("smartrecruiters", [/(?:^|\.)smartrecruiters\.com$/i], smartRecruitersFields(), ["[data-test='application-form']", "[data-testid='application-form']", "main form[action*='application']"], { multiPage: true, resumeAttachment: "manual", applicationState: true }),
  ];

  function detect(value) {
    let hostname = "";
    try { hostname = new URL(value).hostname.toLowerCase(); }
    catch { return unknown(); }
    const definition = definitions.find((item) => item.hosts.some((pattern) => pattern.test(hostname)));
    return definition ? publicDefinition(definition) : unknown();
  }

  function profileKeyFor(adapterId, descriptor) {
    const definition = definitions.find((item) => item.id === adapterId);
    const match = definition?.fields.find((field) => field.pattern.test(String(descriptor || "")));
    return match?.profileKey || "";
  }

  function inspectPage(documentRef, pageUrl) {
    const detected = detect(pageUrl);
    const definition = definitions.find((item) => item.id === detected.id);
    const applicationRoot = applicationRootFor(documentRef, definition);
    const applicationPath = /\/(?:apply|application)(?:\/|$|\?)/i.test(new URL(pageUrl).pathname + new URL(pageUrl).search);
    const fieldRoot = applicationRoot || (applicationPath ? documentRef : null);
    const fields = [...(fieldRoot?.querySelectorAll("input:not([type='hidden']), select, textarea") || [])]
      .filter((field) => !field.disabled);
    const pageText = String(documentRef.body?.innerText || "").replace(/\s+/g, " ").slice(0, 20_000);
    const completionSignals = [
      [/\bapplication (?:has been )?submitted\b/i, "application submitted"],
      [/\bapplication (?:has been )?received\b/i, "application received"],
      [/\bthank you for applying\b/i, "thank you for applying"],
      [/\bthanks for applying\b/i, "thanks for applying"],
    ].filter(([pattern]) => pattern.test(pageText)).map(([, signal]) => signal);
    const complete = completionSignals.length > 0;
    const submitControls = [...(fieldRoot?.querySelectorAll("button, input[type='submit']") || [])]
      .filter((control) => /\b(?:submit application|apply|send application)\b/i.test(controlLabel(control)));
    const nextControls = [...(fieldRoot?.querySelectorAll("button, input[type='button'], input[type='submit']") || [])]
      .filter((control) => /\b(?:next|continue|save and continue)\b/i.test(controlLabel(control)) && !/\bsubmit\b/i.test(controlLabel(control)));
    const profileKeys = fields.map((field) => profileKeyFor(detected.id, fieldDescriptor(field))).filter(Boolean);
    const fileFields = fields.filter((field) => String(field.type || "").toLowerCase() === "file");
    const requiredFields = fields.filter((field) => field.required || field.getAttribute?.("aria-required") === "true");
    const emptyRequiredFields = requiredFields.filter((field) => !fieldHasAnswer(field));
    const stepLabel = stepTitle(documentRef, detected.id) || (fields.length ? "Application" : "Posting");
    return {
      atsFamily: detected.id,
      supported: detected.id !== "generic",
      phase: complete ? "complete" : fields.length ? "application" : "posting",
      fieldCount: fields.length,
      requiredCount: requiredFields.length,
      emptyRequiredCount: emptyRequiredFields.length,
      stepKey: `${detected.id}:${slug(stepLabel)}`,
      stepLabel,
      recognizedProfileFields: [...new Set(profileKeys)],
      fileFieldCount: fileFields.length,
      submitControlCount: submitControls.length,
      nextControlCount: nextControls.length,
      canRunSafeFill: detected.capabilities.safeFieldFill && fields.length > 0 && !complete,
      requiresManualResume: fileFields.length > 0,
      completionSignals,
    };
  }

  function applicationFields(documentRef, pageUrl) {
    const detected = detect(pageUrl);
    const definition = definitions.find((item) => item.id === detected.id);
    const root = applicationRootFor(documentRef, definition);
    const applicationPath = /\/(?:apply|application)(?:\/|$|\?)/i.test(new URL(pageUrl).pathname + new URL(pageUrl).search);
    const fieldRoot = root || (applicationPath ? documentRef : null);
    return [...(fieldRoot?.querySelectorAll("input:not([type='hidden']), select, textarea") || [])].filter((field) => !field.disabled);
  }

  function adapter(id, hosts, fields, applicationRoots, capabilities) {
    return { id, hosts, fields, applicationRoots, capabilities: { safeFieldFill: true, finalSubmit: false, ...capabilities } };
  }

  function publicDefinition(value) {
    return { id: value.id, capabilities: { ...value.capabilities } };
  }

  function unknown() {
    return { id: "generic", capabilities: { safeFieldFill: true, multiPage: false, resumeAttachment: "manual", applicationState: false, finalSubmit: false } };
  }

  scope.ClearLeadAdapters = Object.freeze({
    detect,
    inspectPage,
    applicationFields,
    profileKeyFor,
    supported: Object.freeze(definitions.map(publicDefinition)),
  });

  function fields(entries) { return entries.map(([pattern, profileKey]) => ({ pattern, profileKey })); }
  function applicationRootFor(documentRef, definition) { return definition?.applicationRoots.map((selector) => documentRef.querySelector?.(selector)).find(Boolean) || null; }
  function stepTitle(documentRef, adapterId) {
    const selectors = adapterId === "workday"
      ? ["[data-automation-id='stepTitle']", "[data-automation-id='progressBar'] [aria-current='step']", "h1", "h2"]
      : adapterId === "smartrecruiters"
        ? ["[data-test='step-title']", "[data-testid='step-title']", "[aria-current='step']", "h1", "h2"]
        : ["h1", "h2"];
    for (const selector of selectors) {
      const label = String(documentRef.querySelector?.(selector)?.textContent || "").replace(/\s+/g, " ").trim();
      if (label) return label.slice(0, 100);
    }
    return "";
  }
  function slug(value) { return String(value || "step").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "step"; }
  function fieldDescriptor(field) {
    return [field.name, field.id, field.autocomplete, field.getAttribute?.("aria-label"), field.getAttribute?.("placeholder")].filter(Boolean).join(" ");
  }
  function controlLabel(control) {
    return [control.textContent, control.value, control.getAttribute?.("aria-label"), control.getAttribute?.("title")].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  }
  function fieldHasAnswer(field) {
    const type = String(field.type || "").toLowerCase();
    if (type === "checkbox" || type === "radio") return Boolean(field.checked);
    return Boolean(String(field.value || "").trim());
  }
  function sharedFields() { return fields([
    [/linkedin/i, "linkedinUrl"], [/github/i, "githubUrl"], [/(?:portfolio|personal.?website|personal.?url)/i, "portfolioUrl"],
  ]); }
  function workdayFields() { return [...fields([
    [/(?:legalNameSection|first.?name|given.?name)/i, "firstName"], [/(?:last.?name|family.?name|surname)/i, "lastName"],
    [/(?:emailAddress|email)/i, "email"], [/(?:phoneNumber|phone.?number|mobile)/i, "phone"],
    [/(?:address-level2|city)/i, "city"], [/(?:address-level1|state|region)/i, "state"], [/(?:postal|zip)/i, "postalCode"],
  ]), ...sharedFields()]; }
  function greenhouseFields() { return [...fields([
    [/(?:first_name|first.?name)/i, "firstName"], [/(?:last_name|last.?name)/i, "lastName"],
    [/(?:job_application_email|email)/i, "email"], [/(?:job_application_phone|phone)/i, "phone"], [/(?:job_application_location|location)/i, "location"],
  ]), ...sharedFields()]; }
  function leverFields() { return [...fields([
    [/(?:candidate.?name|full.?name|^name$)/i, "fullName"], [/email/i, "email"], [/phone/i, "phone"], [/location/i, "location"],
  ]), ...sharedFields()]; }
  function ashbyFields() { return [...fields([
    [/(?:candidate.?name|full.?name|^name$)/i, "fullName"], [/email/i, "email"], [/phone/i, "phone"], [/location/i, "location"],
  ]), ...sharedFields()]; }
  function smartRecruitersFields() { return [...fields([
    [/(?:firstName|first.?name)/i, "firstName"], [/(?:lastName|last.?name)/i, "lastName"],
    [/email/i, "email"], [/(?:phoneNumber|phone)/i, "phone"], [/(?:city|location)/i, "location"],
  ]), ...sharedFields()]; }
})(globalThis);
