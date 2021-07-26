import _ from 'lodash'

import sanityClient from 'part:@sanity/base/client'

import {
  PortableTextBlock as PTB,
  PortableTextChild as PTC,
  MarkDef
} from '@sanity/portable-text-editor'
import { randomKey } from '@sanity/block-tools/'

import { SCHEMA_NAME } from '../../../schemas/vocabularyItem';

const apiVersion = `2021-05-19`
const client = sanityClient.withConfig({apiVersion})


// Content Example:
// const content = [
//   {
//     "_type": "block",
//     "_key": "0a0f9ec307f5",
//     "style": "normal",
//     "markDefs": [
//       {
//         "_type": "vocabularyItem",
//         "_key": "1234567",
//         "item": {
//           "_type": "reference",
//           "_ref": "08bc7b40-a77d-4510-957b-066a1ace20e1"
//         }
//       }
//     ],
//     "children": [
//       {
//         "_type": "span",
//         "_key": "2131b94ba51f",
//         "text": "autotroph",
//         "marks": [
//           "1234567"
//         ]
//       }
//     ]
//   }
// ]


export type MD = MarkDef & {
  item: {
    _ref: string
    _type: 'reference'
  }
}


export type VocabularyItem = {
  _id: string;
  _type: string;
  word: string;
}


export type SpanToVocabularyItem = [
  string,
  VocabularyItem?
]


export const getVocabularyItems = async (vocabularyItemIds: string[]): Promise<VocabularyItem[]> => {
  try {
    return await client.fetch(`*[_type == '${SCHEMA_NAME}'
      && _id in $vocabularyItemIds]{ _id, _type, word }`, {vocabularyItemIds})
  } catch (e) {
    console.error(e)
    return []
  }
}


export const performAnnotation = async (content: PTB[], vocabularyItems: VocabularyItem[]) => {

  const getMatchRegex = (term: string) => {
    const escapedTerm = _.escapeRegExp(term)
    // <word-boundary>term[suffix]<word-boundary>
    return new RegExp(`[\\b]*(${escapedTerm}\\w*)[\\b]*`, 'i')
  }

  const getChild = (term: string, child: PTC, markKey?: string): PTC => {
    const newMarks = markKey ? [...child.marks, markKey] : [...child.marks]
    return {
      _type: `span`,
      _key: randomKey(12),
      text: term,
      marks: newMarks,
    }
  }

  const getMarkDef = (markKey: string, match: VocabularyItem): MD => {
    const type = match._type.split('.').pop()
    return {
      _key: markKey,
      _type: type,
      item: {
        _ref: match._id,
        _type: `reference`,
      },
    }
  }

  const getMatchingSpans = (spanText: string, vocabularyItems: VocabularyItem[]): SpanToVocabularyItem[] => {
    const spanToVocabularyItemMap = vocabularyItems.reduce(
      (acc: SpanToVocabularyItem[], vocabularyItem: VocabularyItem) => {
        return acc.reduce((acc2: SpanToVocabularyItem[], [span, match]: SpanToVocabularyItem) => {
          if (match) {
            return [...acc2, [span, match]]
          } else {
            const regex = getMatchRegex(vocabularyItem.word)
            return [
              ...acc2,
                // split by matching criteria
              ...span.split(regex)
                // filter out empty
                .filter(s => s !== "")
                // pair the matched vocabularyItem
                .map(s => [s, regex.test(s) ? vocabularyItem : undefined])
            ]
          }
        }, [])
    }, [[spanText, undefined]]);

    return spanToVocabularyItemMap as SpanToVocabularyItem[]
  }

  const contentWithAnnotations: PTB[] = content.map((block: PTB) => {

    if (!block?.children?.length) {
      return block
    }

    // Sort vocabularyItems by their word length
    vocabularyItems = vocabularyItems.sort((v1, v2) => v2.word.length - v1.word.length)

    const newMarkDefs: MD[] = block.markDefs?.length ? [...block.markDefs] : []
    const markDefKeys: string[] = newMarkDefs.map(md => md._key)

    const newChildren: PTC[] = block.children.reduce((allChildren: PTC[], child: PTC) => {
      const isAnnotated = child.marks?.find(m => markDefKeys.includes(m))

      // Only search spans that have text and are not annotated already
      // but keep existing decorators
      if (child?._type !== 'span' || !child?.text || isAnnotated) {
        return [...allChildren, child]
      }

      // Split span where an item matches and create a list of span-vocabularyItem pair
      const spans: SpanToVocabularyItem[] = getMatchingSpans(child.text, vocabularyItems)

      // If no matches are found, return the child
      if (!spans?.find(([_, vocabulary]) => vocabulary)) {
        return [...allChildren, child]
      }

      // Separate multiple unmatched words from matches ones,
      // and turn them into reference annotations
      const separateTextFromMatches: PTC[] = spans.reduce(
        (acc: PTC[], [spanText, match]: SpanToVocabularyItem) => {

        if (match) {
          const markKey = randomKey(12)
          // Add our markDef to the outer block...
          newMarkDefs.push(getMarkDef(markKey, match))
          // ...and add our new child with annotation
          acc.push(getChild(spanText, child, markKey))
        } else {
          // This span did not match any vocabulary terms so add it as a child
          acc.push(getChild(spanText, child))
        }

        return acc
      }, [])

      return [...allChildren, ...separateTextFromMatches]
    }, [])

    // Compile the new content
    return {...block, children: newChildren, markDefs: newMarkDefs}
  })

  return contentWithAnnotations
}
