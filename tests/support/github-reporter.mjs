// A test reporter for GitHub Actions: failed tests become annotations on the run's summary page, which
// anyone can read without opening the logs.
export default async function* githubReporter(source) {
  for await (const event of source) {
    if (event.type !== 'test:fail' || event.data.details?.type === 'suite') continue;
    const error = event.data.details?.error;
    const message = String(error?.cause?.message ?? error?.cause ?? error?.message ?? 'failed');
    yield `::error::${event.data.name}: ${message.replace(/\s+/g, ' ').slice(0, 500)}\n`;
  }
}
