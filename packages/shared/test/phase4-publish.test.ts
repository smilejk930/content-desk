import { describe, expect, it } from 'vitest';
import {
  addDaysToYmd,
  buildNaverBlogWriteUrl,
  dailyVisitorRequestSchema,
  extractNaverBlogId,
  extractNaverLogNo,
  getKstDateString,
  getKstWeekStartDate,
  isManuscriptApprovedForExport,
  kstDateStartToUtcIso,
  mediaDownloadUrlsRequestSchema,
  registerPublishedPostSchema,
  updateSettingsRequestSchema
} from '../src/index.js';

describe('Phase 4 shared publish domain & schemas', () => {
  it('computes KST dates, week start, and UTC boundaries accurately', () => {
    // 2026-11-25T16:30:00Z = 2026-11-26 01:30:00 KST (Thursday)
    const now = new Date('2026-11-25T16:30:00.000Z');
    expect(getKstDateString(now)).toBe('2026-11-26');
    expect(addDaysToYmd('2026-11-26', 30)).toBe('2026-12-26');
    expect(getKstWeekStartDate(now)).toBe('2026-11-23'); // Monday
    expect(kstDateStartToUtcIso('2026-11-26')).toBe('2026-11-25T15:00:00.000Z');
  });

  it('extracts Naver blog logNo from path segments and logNo query parameters', () => {
    expect(extractNaverLogNo('https://blog.naver.com/my_blog/223456789012')).toBe('223456789012');
    expect(extractNaverLogNo('https://m.blog.naver.com/my_blog/223456789012/')).toBe('223456789012');
    expect(
      extractNaverLogNo('https://blog.naver.com/PostView.naver?blogId=my_blog&logNo=223456789012')
    ).toBe('223456789012');
    expect(
      extractNaverLogNo('https://blog.naver.com/my_blog?Redirect=Log&LOGNO=9988776655')
    ).toBe('9988776655');
    expect(extractNaverLogNo('https://blog.naver.com/my_blog/not-a-number')).toBeNull();
    expect(extractNaverLogNo('javascript:alert(1)')).toBeNull();

    expect(extractNaverBlogId('https://blog.naver.com/My_Blog/223456789012')).toBe('my_blog');
    expect(extractNaverBlogId('https://m.blog.naver.com/Writer01/223456789012')).toBe('writer01');
    expect(
      extractNaverBlogId('https://blog.naver.com/PostView.naver?blogId=TechDesk&logNo=223456789012')
    ).toBe('techdesk');
    expect(extractNaverBlogId('https://blog.naver.com/GoBlogWrite.naver')).toBeNull();
  });

  it('builds safe Naver Blog write URLs and blocks URL injection in naver_blog_id', () => {
    expect(buildNaverBlogWriteUrl('tech_writer-01')).toBe(
      'https://blog.naver.com/tech_writer-01/postwrite'
    );
    expect(buildNaverBlogWriteUrl(null)).toBe('https://blog.naver.com/GoBlogWrite.naver');
    expect(buildNaverBlogWriteUrl('')).toBe('https://blog.naver.com/GoBlogWrite.naver');
    expect(buildNaverBlogWriteUrl('evil.com/x')).toBe('https://blog.naver.com/GoBlogWrite.naver');

    expect(updateSettingsRequestSchema.safeParse({ naver_blog_id: 'valid_id-1' }).success).toBe(true);
    expect(updateSettingsRequestSchema.safeParse({ naver_blog_id: null }).success).toBe(true);
    expect(updateSettingsRequestSchema.safeParse({ naver_blog_id: 'https://evil.com' }).success).toBe(
      false
    );
    expect(updateSettingsRequestSchema.safeParse({ naver_blog_id: '../admin' }).success).toBe(false);
    expect(updateSettingsRequestSchema.safeParse({ naver_blog_id: 'a/b' }).success).toBe(false);
  });

  it('enforces verified copy gate strictly (approved_hash === content_hash && unresolved === 0)', () => {
    const hash = 'a'.repeat(64);
    expect(isManuscriptApprovedForExport({ content_hash: hash, approved_hash: hash }, 0)).toBe(true);
    expect(isManuscriptApprovedForExport({ content_hash: hash, approved_hash: hash }, 1)).toBe(false);
    expect(isManuscriptApprovedForExport({ content_hash: hash, approved_hash: 'b'.repeat(64) }, 0)).toBe(
      false
    );
    expect(isManuscriptApprovedForExport({ content_hash: hash, approved_hash: null }, 0)).toBe(false);
  });

  it('validates media download, published post, and visitor strict schemas', () => {
    expect(mediaDownloadUrlsRequestSchema.safeParse({ manuscript_id: 'ms-1' }).success).toBe(true);
    expect(mediaDownloadUrlsRequestSchema.safeParse({ capture_id: 'cap-1' }).success).toBe(true);
    expect(mediaDownloadUrlsRequestSchema.safeParse({}).success).toBe(false);
    expect(
      mediaDownloadUrlsRequestSchema.safeParse({ manuscript_id: 'ms-1', capture_id: 'cap-1' }).success
    ).toBe(false);

    expect(
      registerPublishedPostSchema.safeParse({
        manuscript_id: 'ms-1',
        post_url: 'https://blog.naver.com/myblog/223456789012',
        target_keywords: ['클라우드플레어']
      }).success
    ).toBe(true);

    expect(
      dailyVisitorRequestSchema.safeParse({
        visit_date: '2026-11-26',
        visitor_count: 150
      }).success
    ).toBe(true);
    expect(
      dailyVisitorRequestSchema.safeParse({
        visit_date: '2026-11-26',
        visitor_count: -1
      }).success
    ).toBe(false);
  });
});
