(function registerClearLeadAdapters(scope) {
  const definitions = [
    adapter("workday", [/(?:^|\.)myworkdayjobs\.com$/i], { multiPage: true, resumeAttachment: "manual", applicationState: true }),
    adapter("greenhouse", [/(?:^|\.)greenhouse\.io$/i, /(?:^|\.)greenhouse\.com$/i], { multiPage: false, resumeAttachment: "manual", applicationState: true }),
    adapter("lever", [/(?:^|\.)lever\.co$/i], { multiPage: false, resumeAttachment: "manual", applicationState: true }),
    adapter("ashby", [/(?:^|\.)ashbyhq\.com$/i], { multiPage: false, resumeAttachment: "manual", applicationState: true }),
    adapter("smartrecruiters", [/(?:^|\.)smartrecruiters\.com$/i], { multiPage: true, resumeAttachment: "manual", applicationState: true }),
  ];

  function detect(value) {
    let hostname = "";
    try { hostname = new URL(value).hostname.toLowerCase(); }
    catch { return unknown(); }
    const definition = definitions.find((item) => item.hosts.some((pattern) => pattern.test(hostname)));
    return definition ? publicDefinition(definition) : unknown();
  }

  function adapter(id, hosts, capabilities) {
    return { id, hosts, capabilities: { safeFieldFill: true, finalSubmit: false, ...capabilities } };
  }

  function publicDefinition(value) {
    return { id: value.id, capabilities: { ...value.capabilities } };
  }

  function unknown() {
    return { id: "generic", capabilities: { safeFieldFill: true, multiPage: false, resumeAttachment: "manual", applicationState: false, finalSubmit: false } };
  }

  scope.ClearLeadAdapters = Object.freeze({
    detect,
    supported: Object.freeze(definitions.map(publicDefinition)),
  });
})(globalThis);
