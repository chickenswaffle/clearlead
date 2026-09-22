(function registerClearLeadAdapters(scope) {
  const definitions = [
    adapter("workday", [/(?:^|\.)myworkdayjobs\.com$/i], workdayFields(), { multiPage: true, resumeAttachment: "manual", applicationState: true }),
    adapter("greenhouse", [/(?:^|\.)greenhouse\.io$/i, /(?:^|\.)greenhouse\.com$/i], greenhouseFields(), { multiPage: false, resumeAttachment: "manual", applicationState: true }),
    adapter("lever", [/(?:^|\.)lever\.co$/i], leverFields(), { multiPage: false, resumeAttachment: "manual", applicationState: true }),
    adapter("ashby", [/(?:^|\.)ashbyhq\.com$/i], ashbyFields(), { multiPage: false, resumeAttachment: "manual", applicationState: true }),
    adapter("smartrecruiters", [/(?:^|\.)smartrecruiters\.com$/i], smartRecruitersFields(), { multiPage: true, resumeAttachment: "manual", applicationState: true }),
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

  function adapter(id, hosts, fields, capabilities) {
    return { id, hosts, fields, capabilities: { safeFieldFill: true, finalSubmit: false, ...capabilities } };
  }

  function publicDefinition(value) {
    return { id: value.id, capabilities: { ...value.capabilities } };
  }

  function unknown() {
    return { id: "generic", capabilities: { safeFieldFill: true, multiPage: false, resumeAttachment: "manual", applicationState: false, finalSubmit: false } };
  }

  scope.ClearLeadAdapters = Object.freeze({
    detect,
    profileKeyFor,
    supported: Object.freeze(definitions.map(publicDefinition)),
  });

  function fields(entries) { return entries.map(([pattern, profileKey]) => ({ pattern, profileKey })); }
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
