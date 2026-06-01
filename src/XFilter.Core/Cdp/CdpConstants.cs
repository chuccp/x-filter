namespace XFilter.Core.Cdp;

public static class CdpConstants
{
    // X.com DOM selectors — must match the existing JS scraper exactly
    public const string TweetArticle = "article[data-testid=\"tweet\"]";
    public const string TweetText = "[data-testid=\"tweetText\"]";
    public const string CaretButton = "button[data-testid=\"caret\"]";
    public const string SocialContext = "[data-testid=\"socialContext\"]";
    public const string ConfirmationSheetConfirm = "[data-testid=\"confirmationSheetConfirm\"]";
    public const string MenuRole = "[role=\"menu\"] [role=\"menuitem\"]";
    public const string CellInnerDiv = "[data-testid=\"cellInnerDiv\"]";
    public const string DiscoverMoreZh = "发现更多";
    public const string DiscoverMoreEn = "Discover more";

    // TreeWalker-based text extraction for emoji support
    public const string TextExtractionJs = @"
(function(el){
  if(!el) return '';
  var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, null, false);
  var text = '';
  var node;
  while(node = walker.nextNode()){
    if(node.nodeType === Node.TEXT_NODE){
      text += node.textContent;
    }else if(node.nodeType === Node.ELEMENT_NODE && node.tagName === 'IMG'){
      text += node.alt || '';
    }
  }
  return text;
})";

    // Post URL extraction regex for profile scraping
    public const string PostUrlPattern = @"^/(\w+)/status/(\d+)";

    // Username extraction from profile links
    public const string UsernameLinkPattern = @"^/(\w+)$";
}
