import PropTypes from 'prop-types';
import React from 'react';
import ImmutablePropTypes from 'react-immutable-proptypes';
import Waypoint from 'react-waypoint';
import { Map } from 'immutable';
import { selectFields, selectInferedField } from 'Reducers/collections';
import EntryCard from './EntryCard';

export default class EntryListing extends React.Component {
  static propTypes = {
    publicFolder: PropTypes.string.isRequired,
    collections: PropTypes.oneOfType([
      ImmutablePropTypes.map,
      ImmutablePropTypes.iterable,
    ]).isRequired,
    entries: ImmutablePropTypes.list,
    onPaginate: PropTypes.func.isRequired,
    page: PropTypes.number,
    viewStyle: PropTypes.string,
  };

  handleLoadMore = () => {
    this.props.onPaginate(this.props.page + 1);
  };

  cursorNext = () => {
    this.props.traverseCursor("next");
  }

  cursorPrev = () => {
    this.props.traverseCursor("prev");
  }

  cursorFirst = () => {
    this.props.traverseCursor("first");
  }

  cursorLast = () => {
    this.props.traverseCursor("last");
  }


  inferFields = collection => {
    const titleField = selectInferedField(collection, 'title');
    const descriptionField = selectInferedField(collection, 'description');
    const imageField = selectInferedField(collection, 'image');
    const fields = selectFields(collection);
    const inferedFields = [titleField, descriptionField, imageField];
    const remainingFields = fields && fields.filter(f => inferedFields.indexOf(f.get('name')) === -1);
    return { titleField, descriptionField, imageField, remainingFields };
  };

  renderCardsForSingleCollection = () => {
    const { collections, entries, publicFolder, viewStyle } = this.props;
    const inferedFields = this.inferFields(collections);
    const entryCardProps = { collection: collections, inferedFields, publicFolder, viewStyle };
    return entries.map((entry, idx) => <EntryCard {...{ ...entryCardProps, entry, key: idx }} />);
  };

  renderCardsForMultipleCollections = () => {
    const { collections, entries, publicFolder } = this.props;
    return entries.map((entry, idx) => {
      const collectionName = entry.get('collection');
      const collection = collections.find(coll => coll.get('name') === collectionName);
      const collectionLabel = collection.get('label');
      const inferedFields = this.inferFields(collection);
      const entryCardProps = { collection, entry, inferedFields, publicFolder, key: idx, collectionLabel };
      return <EntryCard {...entryCardProps}/>;
    });
  };

  render() {
    const { collections, entries, publicFolder } = this.props;

    return (
      <div>
        <div className="nc-entryListing-cardsGrid">
          {
            Map.isMap(collections)
              ? this.renderCardsForSingleCollection()
              : this.renderCardsForMultipleCollections()
          }
          <div>
            <button onClick={this.cursorFirst}>first</button>
            <button onClick={this.cursorPrev}>prev</button>
            <button onClick={this.cursorNext}>next</button>
            <button onClick={this.cursorLast}>last</button>
          </div>
        </div>
      </div>
    );
  }
}
