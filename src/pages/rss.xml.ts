// Combined feed of articles + Howlin' Minute segments, newest first.
// Purpose-built as the trigger source for an email service's "new post ->
// send email" automation (e.g. Mailchimp's RSS Campaigns) — not just a
// generic subscribe feed.
import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { getCollection } from 'astro:content';
import { getHowlinMinuteEntries } from '../lib/data';

export async function GET(context: APIContext) {
  const articles = (await getCollection('articles'))
    .filter((a) => a.data.published)
    .map((a) => ({
      title: a.data.title,
      pubDate: a.data.created_at,
      description: a.data.thesis,
      link: `/articles/${a.id}/`,
    }));

  const clips = getHowlinMinuteEntries().map((e) => ({
    title: `The Howlin' Minute: ${e.title}`,
    pubDate: new Date(e.date),
    description: e.script_text.slice(0, 200),
    link: `/howlin-minute/${e.slug}/`,
  }));

  const items = [...articles, ...clips].sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime());

  return rss({
    title: 'The Daily Guru',
    description: 'Articles and the Howlin\' Minute, as they publish.',
    site: context.site!,
    items,
  });
}
